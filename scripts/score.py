#!/usr/bin/env python3
"""Long-term investment score (0-100) for every stock in data/stocks.json.

Reads annual financials from data/fundamentals.json, scores six categories with
fixed rules, and writes the result into each stock's `lt` field:

  A Financial quality      25    D Competitive strength (proxies)  15
  B Growth & sustainability 20    E Risk & balance sheet             10
  C Valuation               20    F Market trend & sentiment         10

Each metric earns full points, half points, or zero. A metric with no data, or
one that doesn't apply (say EV/EBITDA for a bank), is "n/a": it is left out and
the category is scored on the metrics that remain. A category needs at least
half its points measurable, and a stock needs at least 60 of the 100 category
points measurable, or it gets no score at all.

The thresholds are starting defaults from the design brief, not validated
signals. A score ranks stocks; it is not a probability of making money.
"""
from __future__ import annotations

import json
import math
import statistics
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STOCKS = ROOT / "data" / "stocks.json"
FUNDAMENTALS = ROOT / "data" / "fundamentals.json"
HISTORY = ROOT / "data" / "score_history.json"
HISTORY_WEEKS = 104

WEIGHTS = {"A": 25, "B": 20, "C": 20, "D": 15, "E": 10, "F": 10}
QUALITY_CATS = ("A", "B", "D", "E")
FULL, HALF, ZERO, NA = "full", "half", "zero", "na"
# SKIP = the metric doesn't apply (EV/EBITDA for a bank) or no free source exists
# for anyone (analyst forecasts). Its weight goes to the category's other
# metrics. NA = the data exists in principle but this company didn't report it.
SKIP = "skip"
SPLIT_RATIOS = (2, 3, 4, 5, 6, 8, 10, 15, 20, 25, 30, 40, 50)

TERMINAL_GROWTH = 0.025
STALE_DAYS = 550  # latest annual report older than ~18 months


# ---------- small helpers ----------
def ok(*xs) -> bool:
    return all(x is not None and not (isinstance(x, float) and math.isnan(x)) for x in xs)


def tail(xs: list, n: int) -> list:
    return xs[-n:] if xs else []


def cagr(first, last, years: int) -> float | None:
    if not ok(first, last) or years <= 0 or first <= 0 or last <= 0:
        return None
    return (last / first) ** (1 / years) - 1


def pct(x, d=1) -> str:
    return "n/a" if x is None else f"{x * 100:.{d}f}%"


def mult(x) -> str:
    return "n/a" if x is None else f"{x:.1f}×"


def median(xs):
    xs = [x for x in xs if ok(x)]
    return statistics.median(xs) if xs else None


def growth_over(xs: list, years: int = 3):
    """CAGR from `years` back to the latest value, falling back to the longest span available."""
    vals = [(i, x) for i, x in enumerate(xs) if ok(x)]
    if len(vals) < 2:
        return None, 0
    last_i, last = vals[-1]
    for i, x in vals:
        if last_i - i <= years:
            span = last_i - i
            return (cagr(x, last, span), span) if span >= 2 else (None, span)
    return None, 0


class Card:
    """Collects metric results for one stock."""

    def __init__(self):
        self.metrics: list[list] = []

    def add(self, mid: str, cat: str, mx: float, status: str, shown: str = ""):
        earned = {FULL: mx, HALF: mx / 2, ZERO: 0}.get(status)
        self.metrics.append([mid, cat, earned, mx, shown] + ([1] if status == SKIP else []))

    def tiers(self, mid, cat, mx, value, full_if, half_if, shown, na=False):
        if na:
            self.add(mid, cat, mx, SKIP, shown)
        elif value is None:
            self.add(mid, cat, mx, NA, shown)
        elif full_if(value):
            self.add(mid, cat, mx, FULL, shown)
        elif half_if(value):
            self.add(mid, cat, mx, HALF, shown)
        else:
            self.add(mid, cat, mx, ZERO, shown)

    def category(self, cat: str):
        rows = [m for m in self.metrics if m[1] == cat and len(m) == 5]
        avail = sum(m[3] for m in rows if m[2] is not None)
        earned = sum(m[2] for m in rows if m[2] is not None)
        mx = sum(m[3] for m in rows)
        frac = earned / avail if avail and avail >= mx / 2 else None
        return earned, avail, mx, frac


# ---------- per-company derived series ----------
def split_adjust(shares: list, eps: list, equity: list) -> tuple[list, list]:
    """Undo stock splits in older filings, which report pre-split share counts.

    A split multiplies the share count without bringing in money, so a jump in
    shares with flat equity is treated as a split; a jump with rising equity is
    real issuance and left alone.
    """
    shares, eps = list(shares), list(eps)

    def snap(r):
        k = min(SPLIT_RATIOS, key=lambda x: abs(x - r))
        return k if abs(k - r) / k < 0.15 else None

    for i in range(len(shares) - 1, 0, -1):
        a, b = shares[i - 1], shares[i]
        if not ok(a, b) or a <= 0 or b <= 0:
            continue
        r = b / a
        er = equity[i] / equity[i - 1] if ok(equity[i], equity[i - 1]) and equity[i - 1] > 0 and equity[i] > 0 else None
        k = None
        if r >= 1.8 and (er is None or er < 1.3):
            k = snap(r)
        elif r <= 0.55 and (er is None or er > 0.75):
            k = snap(1 / r)
            k = 1 / k if k else None
        if not k and (r >= 20 or r <= 0.05) and (er is None or not 0.2 < er / r < 5):
            # A 20x jump that equity doesn't share is a units error in the filing.
            if r >= 20:
                shares[i - 1] = eps[i - 1] = None
            else:
                shares[i] = eps[i] = None
            continue
        if k:
            for j in range(i):
                shares[j] = shares[j] * k if ok(shares[j]) else None
                eps[j] = eps[j] / k if ok(eps[j]) else None
    return shares, eps


def derive(f: dict) -> dict:
    n = len(f["fy"])
    g = lambda k: f.get(k) or [None] * n
    rev, opinc, netinc, cfo, capex = g("revenue"), g("opinc"), g("netinc"), g("cfo"), g("capex")
    da, interest, gross, eps, shares = g("da"), g("interest"), g("gross"), g("eps"), g("shares")
    equity, cash, sti = g("equity"), g("cash"), g("sti")
    pretax, tax = g("pretax"), g("tax")

    shares, eps = split_adjust(shares, eps, equity)
    no_capex_tag = all(x is None for x in capex)
    fcf = [c - (0 if no_capex_tag else x) if ok(c) and (no_capex_tag or ok(x)) else None for c, x in zip(cfo, capex)]

    no_debt_tags = all(f.get(k) is None for k in ("ltdebt", "ltdebtNC", "ltdebtC", "stdebt"))
    debt = []
    for i in range(n):
        if no_debt_tags:
            debt.append(0.0)
            continue
        lt = g("ltdebt")[i]
        if lt is None and (ok(g("ltdebtNC")[i]) or ok(g("ltdebtC")[i])):
            lt = (g("ltdebtNC")[i] or 0) + (g("ltdebtC")[i] or 0)
        st = g("stdebt")[i] or 0
        debt.append(None if lt is None and not st else (lt or 0) + st)
    cash_t = [(c or 0) + (s or 0) if ok(c) or ok(s) else None for c, s in zip(cash, sti)]

    def taxrate(i):
        if ok(tax[i], pretax[i]) and pretax[i] > 0:
            return min(max(tax[i] / pretax[i], 0.0), 0.35)
        return 0.21

    roic = []
    for i in range(n):
        if ok(opinc[i], equity[i], debt[i]):
            ic = equity[i] + debt[i] - (cash_t[i] or 0)
            roic.append(opinc[i] * (1 - taxrate(i)) / ic if ic > 0 else None)
        else:
            roic.append(None)
    ebitda = [o + (d or 0) if ok(o) else None for o, d in zip(opinc, da)]
    return {
        "n": n, "rev": rev, "opinc": opinc, "netinc": netinc, "fcf": fcf, "debt": debt, "cash": cash_t,
        "equity": equity, "roic": roic, "ebitda": ebitda, "interest": interest, "gross": gross,
        "eps": eps, "shares": shares, "assetsCur": g("assetsCur"), "liabCur": g("liabCur"), "assets": g("assets"),
        "opm": [o / r if ok(o, r) and r > 0 else None for o, r in zip(opinc, rev)],
        "gm": [x / r if ok(x, r) and r > 0 else None for x, r in zip(gross, rev)],
        "roe": [x / e if ok(x, e) and e > 0 else None for x, e in zip(netinc, equity)],
        "fcfps": [x / s if ok(x, s) and s > 0 else None for x, s in zip(fcf, shares)],
    }


def dcf(base_cf: float, g: float, r: float) -> float:
    """Present value of 5 years at g, 5 years fading to terminal growth, then a terminal value."""
    pv, cf = 0.0, base_cf
    for year in range(1, 11):
        growth = g if year <= 5 else g + (TERMINAL_GROWTH - g) * (year - 5) / 5
        cf *= 1 + growth
        pv += cf / (1 + r) ** year
    terminal = cf * (1 + TERMINAL_GROWTH) / (r - TERMINAL_GROWTH)
    return pv + terminal / (1 + r) ** 10


# ---------- scoring ----------
def first_pass(s: dict, f: dict) -> dict:
    """Valuation multiples used to build sector medians before scoring."""
    d = derive(f)
    mcap = s.get("marketCap")
    ni, eb = d["netinc"][-1], d["ebitda"][-1]
    ev = mcap + (d["debt"][-1] or 0) - (d["cash"][-1] or 0) if ok(mcap) else None
    eq = d["equity"][-1]
    rev_rank_value = d["rev"][-1]
    return {
        "d": d,
        "pe": mcap / ni if ok(mcap, ni) and ni > 0 else None,
        "evEbitda": ev / eb if ok(ev, eb) and eb > 0 and ev > 0 else None,
        "pb": mcap / eq if ok(mcap, eq) and eq > 0 else None,
        "rev": rev_rank_value,
    }


def score_stock(s: dict, f: dict, pre: dict, peers: dict, today: date) -> dict:
    d = pre["d"]
    fin = s.get("sector") == "Finance"
    c = Card()
    mcap, price = s.get("marketCap"), s.get("price")
    L = lambda k: d[k][-1]

    # A. Financial quality (25)
    roic5 = [x for x in tail(d["roic"], 5) if ok(x)]
    roic_med = statistics.median(roic5) if len(roic5) >= 3 else None
    c.tiers("roic", "A", 5, roic_med, lambda v: v >= 0.15, lambda v: v >= 0.10, f"5-yr median ROIC {pct(roic_med)}", na=fin)
    if fin:
        roa3 = [x / a for x, a in zip(tail(d["netinc"], 3), tail(d["assets"], 3)) if ok(x, a) and a > 0]
        roa = sum(roa3) / len(roa3) if len(roa3) >= 2 else None
        c.tiers("roa", "A", 5, roa, lambda v: v >= 0.010, lambda v: v >= 0.007, f"3-yr average return on assets {pct(roa, 2)}")
    fcf5 = [x for x in tail(d["fcf"], 5) if ok(x)]
    pos = sum(x > 0 for x in fcf5)
    c.tiers("fcfPos", "A", 5, (pos, len(fcf5)) if len(fcf5) >= 3 else None,
            lambda v: v[0] >= min(4, v[1]), lambda v: v[0] >= v[1] - 2 and v[0] >= 2,
            f"positive free cash flow in {pos} of {len(fcf5)} years", na=fin)
    opm3 = tail(d["opm"], 3)
    if len(opm3) == 3 and all(ok(x) for x in opm3):
        st = FULL if all(x > 0 for x in opm3) and opm3[-1] >= opm3[0] - 0.01 else HALF if all(x > 0 for x in opm3) else ZERO
        c.add("opm", "A", 4, st, f"operating margin {pct(opm3[0])} → {pct(opm3[-1])} over 3 years")
    else:
        c.add("opm", "A", 4, NA, "operating margin history incomplete")
    roe3 = [x for x in tail(d["roe"], 3) if ok(x)]
    roe_avg = sum(roe3) / len(roe3) if len(roe3) >= 2 else None
    lev = L("debt") / L("equity") if ok(L("debt"), L("equity")) and L("equity") > 0 else None
    c.tiers("roe", "A", 3, roe_avg, lambda v: v >= 0.15 and (lev is None or lev < 2), lambda v: v >= 0.10,
            f"3-yr average ROE {pct(roe_avg)}" + (f", debt/equity {mult(lev)}" if lev is not None else ""))
    f3, n3 = [x for x in tail(d["fcf"], 3) if ok(x)], [x for x in tail(d["netinc"], 3) if ok(x)]
    conv = sum(f3) / sum(n3) if len(f3) == 3 and len(n3) == 3 and sum(n3) > 0 else None
    c.tiers("cashConv", "A", 4, conv, lambda v: v >= 0.8, lambda v: v >= 0.5, f"3-yr free cash flow / net income {pct(conv, 0)}" if conv is not None else "cash conversion not measurable (losses)", na=fin)
    op5 = [x for x in tail(d["opinc"] if not fin else d["netinc"], 5) if ok(x)]
    opos = sum(x > 0 for x in op5)
    c.tiers("earnCons", "A", 4, (opos, len(op5)) if len(op5) >= 3 else None,
            lambda v: v[0] >= min(4, v[1]), lambda v: v[0] >= v[1] - 2 and v[0] >= 2,
            f"profitable in {opos} of {len(op5)} years")

    # B. Growth & sustainability (20)
    rev_g, rspan = growth_over(d["rev"])
    c.tiers("revCagr", "B", 5, rev_g, lambda v: v >= 0.10, lambda v: v >= 0.05, f"{rspan}-yr revenue growth {pct(rev_g)}/yr" if rev_g is not None else "revenue growth not measurable")
    eps_series = d["eps"] if any(ok(x) for x in d["eps"]) else d["netinc"]
    eps_g, espan = growth_over(eps_series)
    turnaround = eps_g is None and ok(eps_series[-1]) and eps_series[-1] > 0
    c.tiers("epsCagr", "B", 4, eps_g, lambda v: v >= 0.10, lambda v: v >= 0.05,
            "turnaround: earnings were negative, growth rate not meaningful" if turnaround else f"{espan}-yr EPS growth {pct(eps_g)}/yr" if eps_g is not None else "EPS growth not measurable (losses)")
    fps_g, fspan = growth_over(d["fcfps"])
    c.tiers("fcfpsCagr", "B", 4, fps_g, lambda v: v >= 0.08, lambda v: v >= 0.04, f"{fspan}-yr free cash flow per share growth {pct(fps_g)}/yr" if fps_g is not None else "free cash flow per share growth not measurable", na=fin)
    c.add("fwdRev", "B", 3, SKIP, "needs analyst forecasts (paid data)")
    c.add("revisions", "B", 2, SKIP, "needs analyst forecasts (paid data)")
    sh_g, sspan = growth_over(d["shares"])
    c.tiers("shares", "B", 2, sh_g, lambda v: v <= 0.01, lambda v: v <= 0.03, f"share count change {pct(sh_g)}/yr" if sh_g is not None else "share count history unavailable")

    # C. Valuation (20) — compared with the median of the same sector
    sec = peers.get(s.get("sector"), {})
    pe, pe_med = pre["pe"], sec.get("pe")
    c.tiers("pe", "C", 4, pe / pe_med if ok(pe, pe_med) else None, lambda v: v <= 0.8, lambda v: v <= 1.0,
            f"P/E {mult(pe)} vs sector {mult(pe_med)}" if pe is not None else "no profits, P/E not meaningful")
    ev_e, ev_med = pre["evEbitda"], sec.get("evEbitda")
    c.tiers("evEbitda", "C", 3, ev_e / ev_med if ok(ev_e, ev_med) else None, lambda v: v <= 0.85, lambda v: v <= 1.0,
            f"EV/EBITDA {mult(ev_e)} vs sector {mult(ev_med)}", na=fin)
    if fin:
        pb, pb_med = pre["pb"], sec.get("pb")
        c.tiers("pb", "C", 4, pb / pb_med if ok(pb, pb_med) else None, lambda v: v <= 0.8, lambda v: v <= 1.0,
                f"price/book {mult(pb)} vs sector {mult(pb_med)}")
        ey = L("netinc") / mcap if ok(L("netinc"), mcap) else None
        c.tiers("earnYield", "C", 5, ey, lambda v: v >= 0.07, lambda v: v >= 0.05, f"earnings yield {pct(ey)}")
    else:
        fy_ = L("fcf") / mcap if ok(L("fcf"), mcap) else None
        c.tiers("fcfYield", "C", 5, fy_, lambda v: v >= 0.05, lambda v: v >= 0.03, f"free cash flow yield {pct(fy_)}")
    peg = pe / (eps_g * 100) if ok(pe, eps_g) and eps_g > 0 else None
    c.tiers("peg", "C", 3, peg, lambda v: 0 < v <= 1.5, lambda v: 0 < v <= 2.5, f"PEG {peg:.2f}" if peg is not None else "PEG needs positive earnings growth")

    # Intrinsic value: DCF on free cash flow (net income for financial companies).
    cf_hist = [x for x in tail(d["netinc"] if fin else d["fcf"], 3) if ok(x)]
    base_cf = None
    if len(cf_hist) == 3 and all(x > 0 for x in cf_hist):
        base_cf = sum(cf_hist) / 3
    elif cf_hist and cf_hist[-1] > 0 and sum(x > 0 for x in cf_hist) >= 2:
        base_cf = cf_hist[-1]
    fv = mos = entry = None
    if base_cf and ok(mcap, price) and mcap > 0:
        g = min(max(rev_g if rev_g is not None else 0.03, -0.05), 0.20)
        nd_e = (L("debt") - L("cash")) / L("ebitda") if ok(L("debt"), L("cash"), L("ebitda")) and L("ebitda") > 0 else None
        r = 0.09 + (0.01 if mcap < 2e9 else 0) + (0.01 if nd_e is not None and nd_e > 3 else 0) - (0.005 if mcap > 2e11 else 0)
        scen = {
            "bear": dcf(base_cf, g * 0.5 if g > 0 else g - 0.02, r + 0.01),
            "base": dcf(base_cf, g, r),
            "bull": dcf(base_cf, min(g * 1.3, 0.25) if g > 0 else g + 0.02, r - 0.005),
        }
        per_share = price / mcap
        fv = [round(scen[k] * per_share, 2) for k in ("bear", "base", "bull")]
        mos = (scen["base"] - mcap) / scen["base"] if scen["base"] > 0 else None
        entry = round(scen["base"] * 0.8 * per_share, 2)
    c.tiers("mos", "C", 5, mos, lambda v: v >= 0.25, lambda v: v >= 0.10,
            f"price is {pct(abs(mos), 0)} {'below' if mos >= 0 else 'above'} estimated fair value" if mos is not None else "fair value needs positive cash flow")

    # D. Competitive strength (15) — measurable proxies only
    hi = sum(x >= 0.15 for x in roic5)
    c.tiers("moat", "D", 5, (hi, len(roic5)) if len(roic5) >= 3 else None,
            lambda v: v[0] >= min(4, v[1]), lambda v: v[0] >= v[1] - 2 and v[0] >= 2,
            f"ROIC ≥15% in {hi} of {len(roic5)} years (persistent high returns)", na=fin)
    if fin:
        roe5 = [x for x in tail(d["roe"], 5) if ok(x)]
        hi_roe = sum(x >= 0.12 for x in roe5)
        c.tiers("moatFin", "D", 5, (hi_roe, len(roe5)) if len(roe5) >= 3 else None,
                lambda v: v[0] >= min(4, v[1]), lambda v: v[0] >= v[1] - 2 and v[0] >= 2,
                f"ROE ≥12% in {hi_roe} of {len(roe5)} years (persistent high returns)")
    rank = sec.get("revRank", {}).get(s["symbol"])
    c.tiers("position", "D", 3, rank, lambda v: v <= 0.10, lambda v: v <= 0.25,
            (f"revenue in the top {math.ceil(rank * 100)}% of its sector" if rank <= 0.5 else "revenue in the bottom half of its sector")
            if rank is not None else "revenue rank unavailable")
    c.add("recurring", "D", 3, SKIP, "needs filing text review (customer retention, contracts)")
    gm3 = tail(d["gm"], 3)
    if len(gm3) == 3 and all(ok(x) for x in gm3):
        steady = gm3[-1] >= gm3[0] - 0.02
        st = FULL if gm3[-1] >= 0.40 and steady else HALF if gm3[-1] >= 0.40 or (gm3[-1] >= 0.25 and steady) else ZERO
        c.add("pricing", "D", 2, st, f"gross margin {pct(gm3[-1])} ({'steady or rising' if steady else 'falling'})")
    else:
        c.add("pricing", "D", 2, SKIP if fin else NA, "gross margin not reported")
    roic_l = d["roic"][-1]
    cap_ok = [roic_l >= 0.10 if ok(roic_l) else None, sh_g <= 0.005 if sh_g is not None else None]
    if fin or all(x is None for x in cap_ok):
        c.add("capAlloc", "D", 2, SKIP if fin else NA, "capital allocation proxy unavailable")
    else:
        hits = sum(bool(x) for x in cap_ok)
        c.add("capAlloc", "D", 2, FULL if hits == 2 else HALF if hits == 1 else ZERO,
              f"latest ROIC {pct(roic_l)}, share count {pct(sh_g)}/yr")

    # E. Risk & balance sheet (10)
    nd = L("debt") - L("cash") if ok(L("debt"), L("cash")) else None
    nd_e = nd / L("ebitda") if ok(nd, L("ebitda")) and L("ebitda") > 0 else None
    if nd is None or fin:
        nd_score, nd_text = None, "debt data unavailable"
    elif nd <= 0:
        nd_score, nd_text = -1.0, "net cash (more cash than debt)"
    elif nd_e is None:
        nd_score, nd_text = 99.0, "net debt with no positive EBITDA to pay it"
    else:
        nd_score, nd_text = nd_e, f"net debt / EBITDA {mult(nd_e)}"
    c.tiers("netDebt", "E", 3, nd_score, lambda v: v < 2, lambda v: v < 3, nd_text, na=fin)
    cov = L("opinc") / L("interest") if ok(L("opinc"), L("interest")) and L("interest") > 0 else None
    if cov is None and ok(L("debt")) and L("debt") == 0:
        cov = 99.0
    c.tiers("coverage", "E", 2, cov, lambda v: v > 5, lambda v: v > 3,
            "no meaningful debt" if cov == 99.0 else f"operating profit covers interest {mult(cov)}", na=fin)
    cr = L("assetsCur") / L("liabCur") if ok(L("assetsCur"), L("liabCur")) and L("liabCur") > 0 else None
    c.tiers("liquidity", "E", 2, cr if not (nd is not None and nd <= 0) else 9.9, lambda v: v >= 1.5, lambda v: v >= 1.0,
            "net cash" if nd is not None and nd <= 0 else f"current ratio {mult(cr)}", na=fin)
    if fin:
        cap_r = L("equity") / L("assets") if ok(L("equity"), L("assets")) and L("assets") > 0 else None
        c.tiers("capital", "E", 3, cap_r, lambda v: v >= 0.10, lambda v: v >= 0.07, f"equity is {pct(cap_r)} of assets (capital cushion)")
    c.add("concentration", "E", 2, SKIP, "needs filing text review (customer concentration)")
    c.add("governance", "E", 1, SKIP, "needs filing text review (governance red flags)")

    # F. Market trend & sentiment (10)
    sma50, sma200, rsi_ = s.get("sma50"), s.get("sma200"), s.get("rsi14")
    c.tiers("above200", "F", 2, (price, sma200) if ok(price, sma200) else None, lambda v: v[0] > v[1], lambda v: False,
            f"price {'above' if ok(price, sma200) and price > sma200 else 'below'} its 200-day average")
    c.tiers("golden", "F", 2, (sma50, sma200) if ok(sma50, sma200) else None, lambda v: v[0] > v[1], lambda v: False,
            f"50-day average {'above' if ok(sma50, sma200) and sma50 > sma200 else 'below'} the 200-day")
    c.tiers("rsi", "F", 1, rsi_, lambda v: 40 <= v <= 65, lambda v: False, f"RSI {rsi_:.0f}" if ok(rsi_) else "RSI n/a")
    c.tiers("macd", "F", 1, s.get("macdW"), lambda v: v > 0, lambda v: False,
            f"weekly MACD histogram {'positive' if (s.get('macdW') or 0) > 0 else 'negative'}")
    r6, r6_med = s.get("r6m"), sec.get("r6m")
    c.tiers("relStr", "F", 2, (r6, r6_med) if ok(r6, r6_med) else None, lambda v: v[0] > v[1], lambda v: False,
            f"6-month return {r6:+.1f}% vs sector median {r6_med:+.1f}%" if ok(r6, r6_med) else "relative strength n/a")
    c.add("sentiment", "F", 2, SKIP, "needs analyst estimate revisions (paid data)")

    # ----- roll-up -----
    cats = {k: c.category(k) for k in WEIGHTS}

    def blend(keys):
        avail = [(WEIGHTS[k], cats[k][3]) for k in keys if cats[k][3] is not None]
        wsum = sum(w for w, _ in avail)
        return (sum(w * fr for w, fr in avail) / wsum * 100, wsum) if wsum else (None, 0)

    total, wsum = blend(WEIGHTS)
    if wsum < 60:
        total = None
    quality, qsum = blend(QUALITY_CATS)
    if qsum < 40:
        quality = None
    vfrac, tfrac = cats["C"][3], cats["F"][3]
    value = (vfrac * 0.8 + (tfrac if tfrac is not None else vfrac) * 0.2) * 100 if vfrac is not None else None
    coverage = sum(m[3] for m in c.metrics if m[2] is not None)

    # ----- hard gates -----
    flags, warns = [], []
    if ok(cov) and cov < 1.5 and not fin and nd is not None and nd > 0:
        flags.append(f"operating profit covers interest only {cov:.1f}×")
    if nd_e is not None and nd_e > 5 and not fin:
        flags.append(f"net debt is {nd_e:.1f}× EBITDA")
    r4 = [x for x in tail(d["rev"], 4) if ok(x)]
    if len(r4) == 4 and r4[0] > r4[1] > r4[2] > r4[3]:
        flags.append("revenue fell three years in a row")
    rps_g, _ = growth_over([r / sh if ok(r, sh) and sh > 0 else None for r, sh in zip(d["rev"], d["shares"])])
    # Issuing shares to buy a business that brings its own revenue isn't the same as diluting owners.
    if sh_g is not None and sh_g > 0.10 and (rps_g is None or rps_g < 0):
        flags.append(f"share count growing {pct(sh_g, 0)} a year (heavy dilution)")
    f3all = tail(d["fcf"], 3)
    if not fin and len(f3all) == 3 and all(ok(x) and x < 0 for x in f3all):
        flags.append("negative free cash flow three years running")
    filed = f.get("filed")
    if ok(L("equity")) and L("equity") < 0:
        warns.append("negative shareholders' equity (often from buybacks, but check)")

    # ----- decision -----
    if total is None:
        signal = "nodata"
    elif flags:
        signal = "risk"
    elif total >= 85 and vfrac is not None and vfrac >= 0.7 and mos is not None and mos >= 0.20:
        signal = "buy"
    elif mos is not None and mos <= -0.6 and total >= 60:
        signal = "trim"
    elif total >= 75:
        signal = "watch"
    elif total >= 60:
        signal = "hold"
    else:
        signal = "avoid"

    r1 = lambda v: None if v is None else round(v, 1)
    return {
        "score": r1(total), "quality": r1(quality), "value": r1(value), "cov": round(coverage),
        "signal": signal, "mos": None if mos is None else round(mos * 100, 1), "fv": fv, "entry": entry,
        "flags": flags, "warns": warns, "fin": fin,
        "cats": {k: [round(v[0], 1), v[1], v[2]] for k, v in cats.items()},
        "m": [[m[0], m[1], m[2], m[3], m[4]] for m in c.metrics],
        "fy": f["fy"][-1], "filed": filed, "cik": f.get("cik"),
        # Six years of headline financials for the detail view's charts ($M and %).
        "fin": {
            "fy": [e[:4] for e in f["fy"]],
            "rev": [None if x is None else round(x / 1e6) for x in d["rev"]],
            "fcf": [None if x is None else round(x / 1e6) for x in d["fcf"]],
            "ni": [None if x is None else round(x / 1e6) for x in d["netinc"]],
            "opm": [None if x is None else round(x * 100, 1) for x in d["opm"]],
            "roic": [None if x is None else round(x * 100, 1) for x in (d["roe"] if fin else d["roic"])],
            "roicLabel": "ROE" if fin else "ROIC",
        },
    }


def update_history(stocks: list, today: date) -> None:
    """Keep one long-term score per stock per week (the week's latest run), two years deep."""
    hist = json.loads(HISTORY.read_text()) if HISTORY.exists() else {"dates": [], "scores": {}}
    dates, scores = hist["dates"], hist["scores"]
    stamp = today.isoformat()
    same_week = bool(dates) and date.fromisoformat(dates[-1]).isocalendar()[:2] == today.isocalendar()[:2]
    if same_week:
        dates[-1] = stamp
    else:
        dates.append(stamp)
    n = len(dates)
    current = {s["symbol"]: s["lt"]["score"] for s in stocks if s.get("lt") and s["lt"].get("score") is not None}
    for sym in set(scores) | set(current):
        col = scores.setdefault(sym, [])
        col.extend([None] * (n - (0 if same_week else 1) - len(col)))  # pad weeks it was missing
        if same_week and len(col) == n:
            col[-1] = current.get(sym)
        else:
            col.append(current.get(sym))
    if n > HISTORY_WEEKS:
        dates[:] = dates[-HISTORY_WEEKS:]
        for sym in scores:
            scores[sym] = scores[sym][-HISTORY_WEEKS:]
    # Drop symbols with nothing left to show.
    hist["scores"] = {k: v for k, v in scores.items() if any(x is not None for x in v)}
    HISTORY.write_text(json.dumps(hist, separators=(",", ":")))


def main() -> None:
    stocks_doc = json.loads(STOCKS.read_text())
    if not FUNDAMENTALS.exists():
        print("no fundamentals.json yet; skipping long-term scores", file=sys.stderr)
        return
    fund = json.loads(FUNDAMENTALS.read_text())["companies"]
    stocks = stocks_doc["stocks"]
    today = date.today()

    # Which listings to score. Several symbols can share one SEC filer: share
    # classes (GOOG/GOOGL) and also preferreds, notes and depositary shares that
    # Nasdaq lists as stocks. Score the main listings (at least half the largest
    # one's market cap) and value them all against the company's full market cap.
    by_cik: dict[int, list] = {}
    for s in stocks:
        if s["symbol"] in fund:
            by_cik.setdefault(fund[s["symbol"]].get("cik", s["symbol"]), []).append(s)
    company: dict[str, dict] = {}
    stale = 0
    for members in by_cik.values():
        cap = max(m.get("marketCap") or 0 for m in members)
        filed = fund[members[0]["symbol"]].get("filed")
        if filed and (today - datetime.strptime(filed, "%Y-%m-%d").date()).days > STALE_DAYS:
            stale += len(members)  # no recent US-GAAP annual report (often foreign filers)
            continue
        for m in members:
            if (m.get("marketCap") or 0) >= cap * 0.5:
                company[m["symbol"]] = dict(m, marketCap=cap)
    print(f"skipping {stale} listings with stale filings", file=sys.stderr)

    pre = {sym: first_pass(s, fund[sym]) for sym, s in company.items()}

    # Sector medians and revenue ranks.
    peers: dict[str, dict] = {}
    by_sector: dict[str, list] = {}
    for s in stocks:
        by_sector.setdefault(s.get("sector"), []).append(s)
    for sector, members in by_sector.items():
        ps = [pre[s["symbol"]] for s in members if s["symbol"] in pre]
        rev_sorted = sorted((p["rev"], s["symbol"]) for s in members if s["symbol"] in pre
                            for p in [pre[s["symbol"]]] if ok(p["rev"]))
        nrev = len(rev_sorted)
        peers[sector] = {
            "pe": median([p["pe"] for p in ps if p["pe"] is not None and p["pe"] < 200]),
            "evEbitda": median([p["evEbitda"] for p in ps if p["evEbitda"] is not None and p["evEbitda"] < 100]),
            "pb": median([p["pb"] for p in ps if p["pb"] is not None and p["pb"] < 50]),
            "r6m": median([s.get("r6m") for s in members]),
            "revRank": {sym: (nrev - i) / nrev for i, (_, sym) in enumerate(rev_sorted)},
        }

    scored = 0
    for s in stocks:
        s.pop("lt", None)
        if s["symbol"] not in pre:
            continue
        try:
            s["lt"] = score_stock(company[s["symbol"]], fund[s["symbol"]], pre[s["symbol"]], peers, today)
            scored += s["lt"]["score"] is not None
        except Exception as exc:  # one malformed filing shouldn't sink the run
            print(f"score {s['symbol']} failed: {exc!r}", file=sys.stderr)

    update_history(stocks, today)
    stocks_doc["fundamentalsAt"] = json.loads(FUNDAMENTALS.read_text()).get("generatedAt")
    stocks_doc["ltScored"] = scored
    STOCKS.write_text(json.dumps(stocks_doc, separators=(",", ":")))
    print(f"long-term scores for {scored} of {len(stocks)} stocks", file=sys.stderr)


if __name__ == "__main__":
    main()
