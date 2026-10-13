#!/usr/bin/env python3
"""Build data/fundamentals.json: annual financial statements from SEC filings.

Uses the SEC's free XBRL "company facts" bulk file (every US filer's reported
numbers, no API key) and keeps the last six fiscal years of the line items the
long-term score needs, for every ticker in data/stocks.json.

Fundamentals change only when companies file, so this runs weekly rather than
daily. Foreign filers reporting under IFRS or in non-USD currencies are skipped
and show as "not enough data" on the dashboard.

Env vars:
  SEC_USER_AGENT  contact string the SEC asks automated clients to send
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
STOCKS = ROOT / "data" / "stocks.json"
OUT = ROOT / "data" / "fundamentals.json"

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
FACTS_ZIP_URL = "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip"
HEADERS = {
    # The SEC requires "Name email@example.com"; set the SEC_USER_AGENT repository variable.
    "User-Agent": os.environ.get("SEC_USER_AGENT") or "TickerWatch research bot https://github.com/coltellislong/tickerwatch",
    "Accept-Encoding": "gzip, deflate",
}
YEARS = 6

# Line item -> us-gaap concepts in priority order. Companies switch tags over
# time, so each fiscal year takes the first concept that reports it.
FLOWS = {
    "revenue": ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
                "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense",
                "SalesRevenueGoodsNet", "SalesRevenueServicesNet"],
    "gross": ["GrossProfit"],
    "opinc": ["OperatingIncomeLoss"],
    "pretax": ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
               "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
               "IncomeLossFromContinuingOperationsBeforeIncomeTaxesDomestic"],
    "tax": ["IncomeTaxExpenseBenefit"],
    "netinc": ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
    "cfo": ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets",
              "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets"],
    "da": ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization",
           "DepreciationAmortizationAndAccretionNet", "Depreciation"],
    "interest": ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestPaidNet"],
}
PER_SHARE = {
    "eps": ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "EarningsPerShareBasic"],
}
SHARE_COUNTS = {
    "shares": ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
               "WeightedAverageNumberOfSharesOutstandingBasic"],
}
INSTANTS = {
    "equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    "cash": ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"],
    "sti": ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
    "ltdebt": ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"],
    "ltdebtNC": ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligationsNoncurrent"],
    "ltdebtC": ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"],
    "stdebt": ["ShortTermBorrowings", "CommercialPaper", "DebtCurrent"],
    "assetsCur": ["AssetsCurrent"],
    "liabCur": ["LiabilitiesCurrent"],
}
ANNUAL_FORMS = ("10-K", "10-K/A", "10-KT", "20-F", "20-F/A", "40-F", "40-F/A")


def get(url: str, **kw) -> requests.Response:
    for attempt in range(5):
        try:
            r = requests.get(url, headers=HEADERS, timeout=120, **kw)
            r.raise_for_status()
            return r
        except Exception as exc:
            if attempt == 4:
                raise
            print(f"GET {url} failed ({exc}); retrying", file=sys.stderr)
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError("unreachable")


def parse_day(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def annual_entries(concept_data: dict, unit: str, duration: bool) -> list[dict]:
    """10-K style full-year (or year-end) values for one concept and unit."""
    rows = []
    for e in concept_data.get("units", {}).get(unit, []):
        if e.get("form") not in ANNUAL_FORMS or e.get("val") is None:
            continue
        if duration:
            if "start" not in e:
                continue
            days = (parse_day(e["end"]) - parse_day(e["start"])).days
            if not 340 <= days <= 380:
                continue
        rows.append(e)
    return rows


def series(gaap: dict, concepts: list[str], unit: str, duration: bool) -> dict[str, tuple[float, str]]:
    """period end date -> (value, filed date); first concept wins per period."""
    out: dict[str, tuple[float, str]] = {}
    for concept in concepts:
        if concept not in gaap:
            continue
        best: dict[str, tuple[float, str]] = {}
        for e in annual_entries(gaap[concept], unit, duration):
            # Restatements appear in later filings; keep the latest-filed value.
            if e["end"] not in best or e["filed"] > best[e["end"]][1]:
                best[e["end"]] = (float(e["val"]), e["filed"])
        for end, v in best.items():
            out.setdefault(end, v)
    return out


def nearest(values: dict[str, tuple[float, str]], end: str, tolerance: int = 10) -> float | None:
    target = parse_day(end)
    for k, (v, _) in values.items():
        if abs((parse_day(k) - target).days) <= tolerance:
            return v
    return None


def extract(facts: dict) -> dict | None:
    gaap = facts.get("facts", {}).get("us-gaap")
    if not gaap:
        return None
    flows = {k: series(gaap, c, "USD", True) for k, c in FLOWS.items()}
    flows.update({k: series(gaap, c, "USD/shares", True) for k, c in PER_SHARE.items()})
    flows.update({k: series(gaap, c, "shares", True) for k, c in SHARE_COUNTS.items()})
    inst = {k: series(gaap, c, "USD", False) for k, c in INSTANTS.items()}

    # Fiscal year ends come from the income statement; drop ends that sit within
    # 300 days of a later one (stub periods from fiscal-year changes).
    ends = sorted(set(flows["revenue"]) | set(flows["netinc"]), reverse=True)
    fy_ends: list[str] = []
    for e in ends:
        if not fy_ends or (parse_day(fy_ends[-1]) - parse_day(e)).days >= 300:
            fy_ends.append(e)
    fy_ends = sorted(fy_ends[:YEARS])
    if len(fy_ends) < 2:
        return None

    rec: dict = {"fy": fy_ends}
    for k, vals in flows.items():
        rec[k] = [nearest(vals, e) for e in fy_ends]
    for k, vals in inst.items():
        rec[k] = [nearest(vals, e) for e in fy_ends]
    filed = [v[1] for vals in flows.values() for k, v in vals.items() if k == fy_ends[-1]]
    rec["filed"] = max(filed) if filed else None
    # Drop all-empty line items to keep the file small.
    return {k: v for k, v in rec.items() if not (isinstance(v, list) and all(x is None for x in v))}


def main() -> None:
    if "@" not in HEADERS["User-Agent"]:
        print("warning: SEC_USER_AGENT has no email address; the SEC will likely refuse the download. "
              "Set it as a repository variable, e.g. 'Your Name you@example.com'.", file=sys.stderr)
    symbols = [s["symbol"] for s in json.loads(STOCKS.read_text())["stocks"]]
    print(f"{len(symbols)} symbols from {STOCKS.name}", file=sys.stderr)

    tickers = get(TICKERS_URL).json()
    cik_by_ticker = {}
    for row in tickers.values():
        cik_by_ticker.setdefault(row["ticker"].upper(), int(row["cik_str"]))
    wanted = {}
    for sym in symbols:
        cik = cik_by_ticker.get(sym.upper()) or cik_by_ticker.get(sym.upper().replace("/", "-")) \
            or cik_by_ticker.get(sym.upper().replace("/", "."))
        if cik:
            wanted.setdefault(cik, []).append(sym)
    print(f"{sum(len(v) for v in wanted.values())} symbols matched to {len(wanted)} SEC filers", file=sys.stderr)

    with tempfile.TemporaryFile() as tmp:
        print("downloading companyfacts.zip", file=sys.stderr)
        with get(FACTS_ZIP_URL, stream=True) as r:
            for chunk in r.iter_content(chunk_size=1 << 20):
                tmp.write(chunk)
        print(f"downloaded {tmp.tell() / 1e9:.2f} GB", file=sys.stderr)
        tmp.seek(0)
        out = {}
        with zipfile.ZipFile(tmp) as z:
            names = set(z.namelist())
            for cik, syms in wanted.items():
                name = f"CIK{cik:010d}.json"
                if name not in names:
                    continue
                with z.open(name) as fh:
                    rec = extract(json.load(io.TextIOWrapper(fh, encoding="utf-8")))
                if rec:
                    rec["cik"] = cik
                    for sym in syms:
                        out[sym] = rec

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "SEC EDGAR XBRL company facts",
        "count": len(out),
        "companies": out,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote fundamentals for {len(out)} symbols to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
