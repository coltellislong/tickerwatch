(() => {
  "use strict";

  const METRICS = {
    lts: { label: "Long-term score", short: "LT score", pct: false },
    ltq: { label: "Business quality", short: "Quality", pct: false },
    ltv: { label: "Value at today's price", short: "Value", pct: false },
    mos: { label: "Margin of safety", short: "MoS", pct: true },
    score: { label: "Momentum score", short: "Momentum", pct: false },
    r1w: { label: "1-week return", short: "1W", pct: true },
    r1m: { label: "1-month return", short: "1M", pct: true },
    r3m: { label: "3-month return", short: "3M", pct: true },
    r6m: { label: "6-month return", short: "6M", pct: true },
    rytd: { label: "YTD return", short: "YTD", pct: true },
    r1y: { label: "1-year return", short: "1Y", pct: true },
  };

  const COLUMNS = [
    { key: "rank", label: "#", sortable: false },
    { key: "symbol", label: "Ticker", cls: "l sym" },
    { key: "setup", label: "Signal", cls: "l", sortable: false },
    { key: "name", label: "Company", cls: "l name" },
    { key: "sector", label: "Sector", cls: "l" },
    { key: "marketCap", label: "Mkt cap", fmt: (v) => fmtCap(v) },
    { key: "price", label: "Price", fmt: (v) => "$" + fmtNum(v, 2) },
    { key: "lts", label: "LT score", fmt: (v) => fmtNum(v, 0), only: "long" },
    { key: "ltq", label: "Quality", fmt: (v) => fmtNum(v, 0), only: "long" },
    { key: "ltv", label: "Value", fmt: (v) => fmtNum(v, 0), only: "long" },
    { key: "mos", label: "MoS", ret: true, only: "long" },
    { key: "fit", label: "Fit", fmt: (v) => fmtNum(v, 0), only: "long", need: () => hasPf() },
    ...["r1w", "r1m", "r3m", "r6m", "rytd", "r1y"].map((k) => ({ key: k, label: METRICS[k].short, ret: true, only: k === "r1w" || k === "r6m" ? "short" : null })),
    { key: "score", label: "Momentum", fmt: (v) => fmtNum(v, 0) },
    { key: "spark", label: "1Y trend", sortable: false },
  ];

  const $ = (id) => document.getElementById(id);
  const state = { data: null, horizon: "long", metric: "lts", sector: "", cap: 0, limit: 50, q: "", sortKey: null, sortDir: -1, setup: "" };

  // ---------- formatting ----------
  function fmtNum(v, d) {
    return v == null ? "—" : v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPct(v) {
    if (v == null) return "—";
    const abs = Math.abs(v);
    const d = abs >= 1000 ? 0 : 1;
    return (v > 0 ? "+" : v < 0 ? "−" : "") + abs.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
  }
  function fmtCap(v) {
    if (v == null) return "—";
    if (v >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
    if (v >= 1e9) return "$" + (v / 1e9).toFixed(1) + "B";
    return "$" + (v / 1e6).toFixed(0) + "M";
  }
  function fmtMetric(key, v) {
    return METRICS[key].pct ? fmtPct(v) : fmtNum(v, 0);
  }
  function retClass(v) {
    return v == null ? "na" : v > 0 ? "up" : v < 0 ? "down" : "";
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
    const ticks = [];
    for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(+t.toFixed(10));
    return { ticks, lo: Math.min(min, ticks[0]), hi: Math.max(max, ticks[ticks.length - 1]) };
  }

  // ---------- tooltip ----------
  const tip = $("tooltip");
  function showTip(evt, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const pad = 12;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  function hideTip() {
    tip.hidden = true;
  }
  function stockTip(s) {
    const rows = ["r1w", "r1m", "r3m", "r6m", "rytd", "r1y"]
      .map((k) => `<div class="r"><span>${METRICS[k].short}</span><b>${fmtPct(s[k])}</b></div>`)
      .join("");
    return `<div class="t">${esc(s.symbol)} · ${esc(s.name)}</div>
      <div class="r"><span>${esc(s.sector)}</span><b>${fmtCap(s.marketCap)}</b></div>
      <div class="r"><span>Price</span><b>$${fmtNum(s.price, 2)}</b></div>${rows}
      <div class="r"><span>Growth score</span><b>${fmtNum(s.score, 0)}</b></div>`;
  }

  // ---------- next-session setups ----------
  // Mechanical momentum rules applied to the latest close. They describe a
  // pattern; they don't predict tomorrow's price.
  const SETUP_LABELS = { breakout: "Breakout", dip: "Buy the dip", hot: "Too hot" };
  const money = (v) => "$" + fmtNum(v, 2);

  function setupFor(s) {
    const { price, sma50, sma200, rsi14, offHigh, volRatio, dollarVol } = s;
    if ([price, sma50, sma200, rsi14].some((v) => v == null)) return null;
    // Skip thinly traded or very cheap shares, where these patterns are unreliable.
    if (price < 5 || (dollarVol != null && dollarVol < 5e6)) return null;
    const trendUp = sma50 > sma200;

    if (rsi14 >= 80 || (s.r1m != null && s.r1m >= 60)) {
      return {
        kind: "hot",
        saw: `${s.symbol} shot up ${fmtPct(s.r1m)} in one month. Its “tiredness meter” (RSI) reads ${fmtNum(rsi14, 0)} out of 100. Above 70 means it has been running hard.`,
        why: "It's like a balloon that got blown up really fast. It might get bigger, but it often lets a little air out first. Buying now means paying the top price right after the rush.",
        hold: "Don't chase it. Check again in a week or two, after it has cooled off.",
      };
    }
    if (trendUp && price > sma50 && offHigh != null && offHigh <= 3 && rsi14 >= 55 && rsi14 < 75 && (volRatio || 0) >= 1.2 && (s.r3m || 0) > 0) {
      const stop = Math.max(sma50, price * 0.92);
      return {
        kind: "breakout",
        stop,
        saw: `${s.symbol} is like a kid climbing stairs. It's ${fmtPct(s.r1y ?? s.r6m)} higher than ${s.r1y != null ? "a year" : "six months"} ago, and right now it's standing ${offHigh < 0.5 ? "on its highest step all year" : `just ${fmtNum(offHigh, 1)}% below its highest step all year`}.`,
        why: `More people than usual are buying it: about ${fmtNum(volRatio, 1)}× its normal amount of trading. When lots of buyers push a stock up to new highs, it often keeps climbing for a while. Its tiredness meter reads ${fmtNum(rsi14, 0)}/100: busy, but not worn out.`,
        hold: "About 4 to 8 weeks, as long as it keeps climbing.",
        exit: `Get out if it closes below ${money(stop)}. That means the stairs broke. If it keeps rising, move that exit price up to its 50-day average each week.`,
      };
    }
    if (trendUp && price > sma200 && price >= sma50 * 0.95 && (s.score || 0) >= 80 && s.r1w != null && s.r1w <= -2 && s.r1w >= -10 && rsi14 >= 35 && rsi14 <= 50) {
      const stop = Math.max(sma200, price * 0.9);
      return {
        kind: "dip",
        stop,
        saw: `${s.symbol} has been one of the steadiest climbers on the market (growth score ${fmtNum(s.score, 0)} out of 100), but it slipped ${fmtNum(Math.abs(s.r1w), 1)}% this week.`,
        why: `It's like a fast runner stopping to tie a shoe. The big trend still points up: the price is above its 200-day average (${money(sma200)}), the slow line that shows where a stock is heading over many months. Buying a small dip in a strong climber is a common strategy.`,
        hold: "About 1 to 3 months.",
        exit: `Get out if it closes below ${money(stop)}. That would mean the runner has stopped, not just paused.`,
      };
    }
    return null;
  }

  // ---------- my portfolio (kept in this browser's localStorage only) ----------
  const POS_CAP = 5;      // max % of the portfolio in one stock
  const SECTOR_CAP = 25;  // max % in one sector
  const STARTER = 2.5;    // a typical first position, % of the portfolio
  const SPEC_CAP = 5;     // max % in speculative holdings (no score or score < 50)
  const PF_KEY = "tickerwatch.portfolio.v1";
  const pf = { positions: [], cash: 0 };
  let P = null; // derived portfolio numbers, rebuilt by computePf()
  const bySym = new Map();

  function loadPf() {
    try {
      const v = JSON.parse(localStorage.getItem(PF_KEY) || "null");
      if (v && Array.isArray(v.positions)) {
        pf.positions = v.positions.filter((p) => p && typeof p.sym === "string" && p.shares > 0);
        pf.cash = +v.cash || 0;
      }
    } catch { /* storage blocked: start empty */ }
  }
  function savePf() {
    try { localStorage.setItem(PF_KEY, JSON.stringify(pf)); } catch { /* not persisted */ }
  }
  const hasPf = () => pf.positions.length > 0;
  const isSpeculative = (s) => !s || !s.lt || s.lt.score == null || s.lt.score < 50;

  function computePf() {
    const rows = pf.positions.map((p) => {
      const s = bySym.get(p.sym);
      const value = s && s.price != null ? s.price * p.shares : null;
      const gain = value != null && p.cost ? value - p.cost * p.shares : null;
      return { ...p, s, value, gain, gainPct: gain != null ? (gain / (p.cost * p.shares)) * 100 : null };
    });
    const invested = rows.reduce((a, r) => a + (r.value || 0), 0);
    const total = invested + (pf.cash || 0);
    for (const r of rows) r.weight = total ? ((r.value || 0) / total) * 100 : 0;
    const sectors = {};
    for (const r of rows) {
      const k = (r.s && r.s.sector) || "Unknown";
      sectors[k] = (sectors[k] || 0) + r.weight;
    }
    const withCost = rows.filter((r) => r.gain != null);
    const gain = withCost.reduce((a, r) => a + r.gain, 0);
    const cost = withCost.reduce((a, r) => a + r.cost * r.shares, 0);
    // Value of today's holdings along the past year's weekly closes, for drawdown alerts.
    let dd = null;
    const sp = rows.filter((r) => r.s && r.s.spark && r.s.spark.length > 1);
    if (sp.length) {
      const n = Math.min(...sp.map((r) => r.s.spark.length));
      const series = Array.from({ length: n }, (_, i) => sp.reduce((a, r) => a + r.shares * r.s.spark[r.s.spark.length - n + i], 0) + (pf.cash || 0));
      dd = (series[n - 1] / Math.max(...series) - 1) * 100;
    }
    const spec = rows.filter((r) => isSpeculative(r.s)).reduce((a, r) => a + r.weight, 0);
    P = { rows, invested, total, sectors, gain: withCost.length ? gain : null, gainPct: cost ? (gain / cost) * 100 : null, dd, spec, held: new Map(rows.map((r) => [r.sym, r])) };
    for (const s of state.data.stocks) s.fit = fitScore(s);
  }

  // Portfolio Fit (0-100): would adding this stock respect your limits and diversify you?
  function fitScore(s) {
    if (!hasPf()) return null;
    const h = P.held.get(s.symbol);
    const w = h ? h.weight : 0;
    const after = w + (h ? 0 : STARTER);
    const pos = after <= POS_CAP ? 40 : Math.max(0, 40 * (1 - (after - POS_CAP) / POS_CAP));
    const secAfter = (P.sectors[s.sector] || 0) + (h ? 0 : STARTER);
    const sec = secAfter <= SECTOR_CAP ? 35 : secAfter <= SECTOR_CAP + 5 ? 17.5 : 0;
    const same = P.rows.filter((r) => r.s && r.s.sector === s.sector && r.sym !== s.symbol).length;
    const div = same === 0 ? 25 : same <= 2 ? 12.5 : 0;
    let fit = pos + sec + div;
    if (!h && isSpeculative(s) && P.spec + STARTER > SPEC_CAP) fit = Math.min(fit, 30);
    return Math.round(fit);
  }

  // ---------- long-term signals (scored in scripts/score.py, adjusted for your holdings) ----------
  const LT_SIGNALS = {
    buy: { label: "Buy review", tone: "buy" },
    accumulate: { label: "Accumulate", tone: "buy" },
    watch: { label: "Watchlist", tone: "neutral" },
    hold: { label: "Hold / fair", tone: "neutral" },
    holdOwned: { label: "Hold", tone: "neutral" },
    trim: { label: "Trim review", tone: "warn" },
    exit: { label: "Exit review", tone: "risk" },
    avoid: { label: "Avoid", tone: "muted" },
    risk: { label: "Risk review", tone: "risk" },
  };
  const LT_CATS = [
    ["A", "Quality"], ["B", "Growth"], ["C", "Valuation"],
    ["D", "Moat"], ["E", "Risk"], ["F", "Trend"],
  ];
  function ltClass(v) {
    return v >= 90 ? "Exceptional" : v >= 80 ? "Strong" : v >= 70 ? "Attractive" : v >= 60 ? "Fair" : v >= 50 ? "Weak" : "Unattractive";
  }
  const valFrac = (lt) => (lt.cats && lt.cats.C[1] ? lt.cats.C[0] / lt.cats.C[1] : null);

  // Long-term signal for a stock: the model's own call, then the portfolio rules.
  function ltSig(s) {
    const lt = s.lt;
    const h = P && P.held.get(s.symbol);
    if (h) {
      const sec = P.sectors[s.sector] || 0;
      if (!lt || lt.score == null) return { kind: "holdOwned", why: ["there isn't enough filing data to score it, so watch it yourself"] };
      if (lt.flags.length) return { kind: "exit", why: lt.flags };
      if (lt.score < 50) return { kind: "exit", why: [`its score has fallen to ${fmtNum(lt.score, 0)}`] };
      if (h.weight > POS_CAP) return { kind: "trim", why: [`it is ${fmtNum(h.weight, 1)}% of your portfolio, above the ${POS_CAP}% cap`] };
      if (lt.mos != null && lt.mos <= -60) return { kind: "trim", why: [`the price is ${fmtNum(-lt.mos, 0)}% above the fair-value estimate`] };
      const cheap = (valFrac(lt) != null && valFrac(lt) >= 0.6) || (lt.mos != null && lt.mos >= 10);
      if (lt.score >= 80 && cheap && h.weight + 1 <= POS_CAP && sec + 1 <= SECTOR_CAP) {
        return { kind: "accumulate", why: [`score ${fmtNum(lt.score, 0)}`, "still attractively valued", `${fmtNum(POS_CAP - h.weight, 1)} points of room under the position cap`] };
      }
      const why = [];
      if (lt.score < 80) why.push(`the score is ${fmtNum(lt.score, 0)} (adding needs 80)`);
      else if (!cheap) why.push("the price isn't attractive enough to add more");
      else why.push("there's no room left under the position or sector cap");
      return { kind: "holdOwned", why };
    }
    if (!lt || !lt.signal || lt.signal === "nodata") return null;
    if (lt.signal === "buy" && hasPf()) {
      const secAfter = (P.sectors[s.sector] || 0) + STARTER;
      if (secAfter > SECTOR_CAP) return { kind: "watch", why: [`a starter position would put ${s.sector} at ${fmtNum(secAfter, 0)}% of your portfolio, over the ${SECTOR_CAP}% cap`] };
    }
    return { kind: lt.signal, why: [] };
  }

  // The signal shown for a stock under the current horizon.
  function sigOf(s) {
    if (state.horizon === "short") {
      return s.setup ? { kind: s.setup.kind, label: SETUP_LABELS[s.setup.kind], tone: s.setup.kind === "hot" ? "warn" : "buy" } : null;
    }
    const sig = ltSig(s);
    return sig ? { kind: sig.kind, ...LT_SIGNALS[sig.kind] } : null;
  }
  // Plain-language reading of a 0-100 sub-score.
  const grade = (v) => (v == null ? "not enough data" : v >= 80 ? "great" : v >= 65 ? "good" : v >= 50 ? "so-so" : "weak");

  // The long-term story in plain language; shared by the Why? popover and the detail view.
  function ltNarrative(s) {
    const lt = s.lt;
    const sig = ltSig(s) || { kind: lt.signal, why: [] };
    const k = sig.kind;
    const metric = (id) => lt.m.find((m) => m[0] === id);
    // Only business measures answer "is it a good business?"; price and trend have their own questions.
    const isBiz = (m) => m.length === 5 && "ABDE".includes(m[1]);
    const best = lt.m.filter((m) => isBiz(m) && m[2] != null && m[2] === m[3]).slice(0, 2).map((m) => m[4]);
    const worst = lt.m.filter((m) => isBiz(m) && m[2] === 0).slice(0, 2).map((m) => m[4]);
    const fv = lt.fv;
    const price = s.price;

    const business = `Buying a stock is like buying part of a lemonade stand. This stand looks <b>${grade(lt.quality)}</b> (quality ${fmtNum(lt.quality, 0)}/100).` +
      (best.length ? ` Good signs: ${best.map(esc).join("; ")}.` : "") +
      (worst.length ? ` Weak spots: ${worst.map(esc).join("; ")}.` : "");
    let pricePara;
    if (fv) {
      const cheap = lt.mos >= 0;
      pricePara = `Adding up the cash it should make in future, it's worth about <b>$${fmtNum(fv[1], 2)}</b> a share ($${fmtNum(fv[0], 2)} if things go badly, $${fmtNum(fv[2], 2)} if great). ` +
        `Today's $${fmtNum(price, 2)} is ${cheap ? `<b>${fmtNum(lt.mos, 0)}% below</b>` : `<b>${fmtNum(-lt.mos, 0)}% above</b>`} that. ` +
        (cheap ? "Paying less than it's worth gives you a cushion if you're wrong." : "The price already assumes a lot of good news.") +
        (lt.mos < -50 ? " This estimate is deliberately cautious (growth capped at 20% a year), so fast growers often look expensive on it." : "");
    } else {
      pricePara = "There isn't enough steady cash flow to estimate a fair value, so treat the price with extra caution.";
    }
    pricePara += ` Value score: ${fmtNum(lt.value, 0)}/100.`;
    const trendBits = ["above200", "golden", "relStr"].map(metric).filter(Boolean);
    const trendUp = trendBits.filter((m) => m[2] === m[3]).length;
    const timing = `The price trend is <b>${trendUp >= 2 ? "pointing up" : trendUp === 1 ? "mixed" : "pointing down"}</b> (${trendBits.map((m) => esc(m[4])).join("; ")}). ` +
      "For a long-term owner this matters least; a dip can be a chance to buy a good business cheaper.";

    const because = sig.why.length ? ` Why: ${sig.why.map(esc).join("; ")}.` : "";
    let plan;
    if (k === "buy") {
      plan = `Passes every buy check (score ≥ 85, valuation ≥ 14/20, ≥ 20% below fair value${hasPf() ? ", fits your sector cap" : ""}). A <b>3–10 year</b> idea: start small (2–3% of your portfolio), add while the business keeps performing, and don't sell just because the price drops.`;
    } else if (k === "accumulate") {
      plan = `You own it and it still earns its place: you could <b>add a little more</b> while staying under the ${POS_CAP}% position cap.${because}`;
    } else if (k === "holdOwned") {
      plan = `You own it and nothing has broken, so <b>holding</b> is reasonable. Don't add more right now.${because}`;
    } else if (k === "exit") {
      plan = `You own it, and something important has changed: <b>review whether your reason for owning it still holds</b>.${because} An exit review isn't an automatic sale; think about taxes and whether the story has really changed.`;
    } else if (k === "watch") {
      const why = [...sig.why];
      if (!why.length) {
        if (lt.score < 85) why.push(`the score is ${fmtNum(lt.score, 0)} (a buy needs 85)`);
        if (valFrac(lt) != null && valFrac(lt) < 0.7) why.push("the valuation checks aren't strong enough");
        if (lt.mos == null || lt.mos < 20) why.push("the price isn't 20% below fair value yet");
      }
      plan = `A good business to keep an eye on, but not a buy today because ${why.map(esc).join(" and ") || "it narrowly misses a buy check"}.` +
        (lt.entry && lt.entry < price ? ` A more attractive entry would be around <b>$${fmtNum(lt.entry, 2)}</b> or lower.` : "");
    } else if (k === "hold") {
      plan = "A fair business at a fair-ish price. If you already own it and nothing has broken, holding is reasonable. Not a priority for new money.";
    } else if (k === "trim") {
      plan = `${P && P.held.has(s.symbol) ? "You own it, but" : "Decent business, but"} it's time to <b>consider trimming</b> back toward a normal position size.${because || " Why: the price is far above the fair-value estimate."} That's a review, not an automatic sale: think about taxes and whether the story has really changed.`;
    } else if (k === "risk") {
      plan = `Blocked from any buy signal by a red flag: ${lt.flags.map(esc).join("; ")}. If you own it, check whether the reason you bought it still holds.`;
    } else {
      plan = "The numbers don't make a strong case right now. Avoid new buying until the business or the price improves.";
    }
    const changes = [];
    if (["buy", "watch", "hold", "accumulate", "holdOwned"].includes(k)) {
      changes.push("revenue growth slowing below 5% a year", "returns on capital falling below 10%", "debt climbing above 3× EBITDA");
      if (fv) changes.push(`the price rising above $${fmtNum(fv[1], 2)} (no more discount)`);
    } else if (k === "risk" || k === "exit") {
      changes.push("the red flags clearing in the next annual report");
    } else {
      changes.push("stronger profits or cash flow in the next annual report", fv ? `the price falling toward $${fmtNum(lt.entry, 2)}` : "positive free cash flow");
    }
    let mine = "";
    if (hasPf()) {
      const h = P.held.get(s.symbol);
      const sec = P.sectors[s.sector] || 0;
      mine = h
        ? `You own ${fmtNum(h.shares, 0)} shares: ${fmtNum(h.weight, 1)}% of your portfolio (cap ${POS_CAP}%). ${esc(s.sector)} is ${fmtNum(sec, 0)}% (cap ${SECTOR_CAP}%).`
        : `You don't own it. A ${STARTER}% starter position would bring ${esc(s.sector)} to ${fmtNum(sec + STARTER, 0)}% of your portfolio (cap ${SECTOR_CAP}%). Portfolio Fit: <b>${fmtNum(s.fit, 0)}/100</b>.`;
    }
    return { kind: k, label: LT_SIGNALS[k].label, business, pricePara, timing, plan, changes, mine };
  }

  function catBars(lt) {
    return LT_CATS.map(([k, name]) => {
      const [earned, avail] = lt.cats[k];
      const w = avail ? Math.round((earned / avail) * 100) : 0;
      return `<div class="cat"><span>${name}</span><span class="cat-bar"><i style="width:${w}%"></i></span><span class="cat-v">${avail ? `${fmtNum(earned, 1)}/${avail}` : "n/a"}</span></div>`;
    }).join("");
  }
  const ltNote = (lt) => `Based on SEC filings through fiscal year ending ${esc(lt.fy)} and prices from ${esc(state.data.asOf)}. ${lt.cov}% of the model's points could be measured; analyst forecasts and judgment calls like moat and management aren't included. The score ranks stocks; a 90 does not mean a 90% chance of making money. Not financial advice.`;

  function ltExplain(s) {
    const lt = s.lt;
    const n = ltNarrative(s);
    return `
      <div class="ex-head"><span class="badge ${n.kind}">${n.label}</span><b>${esc(s.symbol)}</b><span class="ex-name">${esc(s.name)}</span></div>
      <div class="ex-score"><b>${fmtNum(lt.score, 0)}</b><span>/100 · ${ltClass(lt.score)}</span></div>
      <div class="cats">${catBars(lt)}</div>
      <p class="ex-k">1. Is it a good business?</p><p>${n.business}</p>
      <p class="ex-k">2. Is it a good price?</p><p>${n.pricePara}</p>
      <p class="ex-k">3. Is now a good time?</p><p>${n.timing}</p>
      <p class="ex-k">What to do</p><p>${n.plan}</p>
      ${n.mine ? `<p class="ex-k">Your portfolio</p><p>${n.mine}</p>` : ""}
      <p class="ex-k">What would change this</p><p>${n.changes.map(esc).join("; ")}.</p>
      <p class="ex-note">${ltNote(lt)} Click the row for charts and every metric.</p>`;
  }

  const explainBox = $("explain");
  let explainFor = null;
  let explainOpenedAt = 0;
  function showExplain(btn) {
    const s = state.data.stocks.find((x) => x.symbol === btn.dataset.sym);
    if (!s) return;
    if (state.horizon === "long") {
      if (!s.lt || s.lt.score == null) return;
      explainBox.innerHTML = ltExplain(s);
      return openExplain(btn);
    }
    if (!s.setup) return;
    const u = s.setup;
    const buy = u.kind !== "hot";
    explainBox.innerHTML = `
      <div class="ex-head"><span class="badge ${u.kind}">${SETUP_LABELS[u.kind]}</span><b>${esc(s.symbol)}</b><span class="ex-name">${esc(s.name)}</span></div>
      <p class="ex-k">What it saw</p><p>${esc(u.saw)}</p>
      <p class="ex-k">${buy ? "Why it might keep going" : "Why it's a warning"}</p><p>${esc(u.why)}</p>
      <p class="ex-k">${buy ? "How long to stay in" : "What to do"}</p><p>${esc(u.hold)}</p>
      ${u.exit ? `<p class="ex-k">When to leave</p><p>${esc(u.exit)}</p>` : ""}
      <p class="ex-note">A simple rule applied to the ${esc(state.data.asOf)} closing prices, not a prediction or financial advice. Prices can jump or drop at the open. Only invest money you can afford to lose.</p>`;
    openExplain(btn);
  }
  function openExplain(btn) {
    explainBox.hidden = false;
    explainFor = btn;
    explainOpenedAt = Date.now();
    btn.setAttribute("aria-expanded", "true");
    placeExplain();
  }
  const sheet = window.matchMedia("(hover: none)");
  function placeExplain() {
    if (!explainFor || sheet.matches) return; // touch screens get a bottom sheet (CSS)
    const r = explainFor.getBoundingClientRect();
    const box = explainBox.getBoundingClientRect();
    let x = Math.min(r.left, window.innerWidth - box.width - 8);
    let y = r.bottom + 6;
    if (y + box.height > window.innerHeight - 8) y = Math.max(8, r.top - box.height - 6);
    explainBox.style.left = Math.max(8, x) + "px";
    explainBox.style.top = y + "px";
  }
  function hideExplain() {
    explainBox.hidden = true;
    if (explainFor) explainFor.setAttribute("aria-expanded", "false");
    explainFor = null;
  }

  // ---------- render: my portfolio ----------
  function renderPortfolio() {
    const body = $("pf-body");
    $("pf-cash").value = pf.cash ? pf.cash : "";
    if (!hasPf()) {
      body.innerHTML = `<div class="pf-empty">
        <p><b>Add what you own</b> to turn the long-term signals personal:</p>
        <ul>
          <li><b>Accumulate / Hold / Trim / Exit</b> calls for each of your stocks</li>
          <li>Alerts when one stock passes ${POS_CAP}% of your money, a sector passes ${SECTOR_CAP}%, or your holdings fall 10%, 15% or 20% from their high</li>
          <li>A <b>Portfolio Fit</b> score on every stock: would buying it keep you diversified and inside your limits?</li>
        </ul></div>`;
      return;
    }
    const alerts = [];
    for (const r of P.rows) {
      if (!r.s) alerts.push(["warn", `${r.sym} isn't in today's data (not listed or under $300M), so it has no price.`]);
      if (r.weight > POS_CAP) alerts.push(["warn", `${r.sym} is ${fmtNum(r.weight, 1)}% of your portfolio, above the ${POS_CAP}% cap.`]);
      const sig = r.s && ltSig(r.s);
      if (sig && sig.kind === "exit") alerts.push(["risk", `${r.sym}: exit review (${sig.why.join("; ")}).`]);
    }
    for (const [sec, w] of Object.entries(P.sectors)) if (w > SECTOR_CAP) alerts.push(["warn", `${sec} is ${fmtNum(w, 0)}% of your portfolio, above the ${SECTOR_CAP}% sector cap.`]);
    if (P.spec > SPEC_CAP) alerts.push(["warn", `${fmtNum(P.spec, 1)}% is in speculative holdings (no score or score under 50), above the ${SPEC_CAP}% limit.`]);
    if (P.dd != null && P.dd <= -10) {
      const lvl = P.dd <= -20 ? 20 : P.dd <= -15 ? 15 : 10;
      alerts.push([lvl >= 20 ? "risk" : "warn", `Your holdings are ${fmtNum(-P.dd, 1)}% below their 1-year high (past the −${lvl}% alert). Check each business, not just the price.`]);
    }
    const stats = [
      ["Value", "$" + fmtNum(P.total, 0), pf.cash ? `incl. $${fmtNum(pf.cash, 0)} cash` : `${P.rows.length} positions`],
      ["Gain / loss", P.gain == null ? "—" : (P.gain >= 0 ? "+$" : "−$") + fmtNum(Math.abs(P.gain), 0), P.gainPct == null ? "add average cost to see this" : fmtPct(P.gainPct) + " on cost", P.gain == null ? "" : retClass(P.gain)],
      ["From 1-year high", P.dd == null ? "—" : fmtPct(P.dd), "alerts at −10%, −15%, −20%", P.dd != null && P.dd <= -10 ? "down" : ""],
      ["Alerts", String(alerts.length), alerts.length ? "see below" : "all limits respected", alerts.length ? "down" : "up"],
    ];
    const rows = [...P.rows].sort((a, b) => (b.value || 0) - (a.value || 0)).map((r) => {
      const sig = r.s && ltSig(r.s);
      const badge = sig ? `<span class="badge ${sig.kind}">${LT_SIGNALS[sig.kind].label}</span>` : "";
      return `<tr data-sym="${esc(r.sym)}">
        <td class="l sym">${esc(r.sym)}</td><td>${fmtNum(r.shares, r.shares % 1 ? 2 : 0)}</td>
        <td>${r.value == null ? "—" : "$" + fmtNum(r.value, 0)}</td>
        <td class="${r.weight > POS_CAP ? "down" : ""}">${fmtNum(r.weight, 1)}%</td>
        <td class="${retClass(r.gain)}">${r.gainPct == null ? "—" : fmtPct(r.gainPct)}</td>
        <td class="l">${badge}</td>
        <td><button type="button" class="pf-rm" data-sym="${esc(r.sym)}" aria-label="Remove ${esc(r.sym)}">Remove</button></td></tr>`;
    }).join("");
    body.innerHTML = `
      <div class="pf-stats">${stats.map(([l, v, n, c]) => `<div class="tile"><div class="label">${l}</div><div class="value ${c || ""}">${esc(v)}</div><div class="note">${esc(n)}</div></div>`).join("")}</div>
      ${alerts.length ? `<ul class="pf-alerts">${alerts.map(([t, m]) => `<li class="${t}"><span class="badge ${t === "risk" ? "risk" : "trim"}">${t === "risk" ? "Review" : "Limit"}</span>${esc(m)}</li>`).join("")}</ul>` : ""}
      <div class="grid2 pf-grid">
        <div class="table-wrap"><table class="pf-table">
          <thead><tr><th class="l">Ticker</th><th>Shares</th><th>Value</th><th>Weight</th><th>Gain</th><th class="l">Signal</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        <figure class="pf-sectors"><figcaption><h3>Sector exposure</h3><p class="hint">Dashed line = ${SECTOR_CAP}% cap</p></figcaption><div id="chart-pf" class="chart"></div></figure>
      </div>`;
    const secs = Object.entries(P.sectors).sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label: label.length > 22 ? label.slice(0, 21) + "…" : label, value, full: label }));
    barChart($("chart-pf"), secs, {
      aria: "Portfolio weight by sector",
      labelW: 150,
      ref: SECTOR_CAP,
      tickFmt: (t) => t + "%",
      tip: (d) => `<div class="t">${esc(d.full)}</div><div class="r"><span>Share of portfolio</span><b>${fmtNum(d.value, 1)}%</b></div><div class="r"><span>Cap</span><b>${SECTOR_CAP}%</b></div>`,
    });
  }

  function upsertPosition(sym, shares, cost) {
    const i = pf.positions.findIndex((p) => p.sym === sym);
    const rec = { sym, shares, cost: cost || (i >= 0 ? pf.positions[i].cost : null) };
    if (i >= 0) pf.positions[i] = rec; else pf.positions.push(rec);
    savePf();
  }
  function portfolioChanged() {
    computePf();
    render();
  }

  // ---------- detail view ----------
  const detail = $("detail");
  let history = null; // weekly long-term scores, loaded on first use

  async function loadHistory() {
    if (history) return history;
    const el = document.getElementById("history-data");
    try {
      history = el ? JSON.parse(el.textContent) : await (await fetch("data/score_history.json", { cache: "no-cache" })).json();
    } catch {
      history = { dates: [], scores: {} };
    }
    return history;
  }

  // Small vertical bar chart: one value per fiscal year, negatives in red.
  function miniBars(el, labels, values, fmt) {
    const W = Math.max(220, el.clientWidth), H = 150, L = 46, R = 6, T = 10, B = 22;
    const vals = values.map((v) => (v == null ? null : v));
    const present = vals.filter((v) => v != null);
    if (!present.length) { el.innerHTML = `<p class="hint">Not reported</p>`; return; }
    const { ticks, lo, hi } = niceTicks(Math.min(0, ...present), Math.max(0, ...present), 4);
    const sy = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
    const bw = (W - L - R) / vals.length;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    for (const t of ticks) svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 6}" y="${sy(t) + 4}" text-anchor="end">${esc(fmt(t, true))}</text>`;
    vals.forEach((v, i) => {
      const x = L + i * bw;
      svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(labels[i])}</text>`;
      if (v == null) return;
      const y0 = sy(0), y1 = sy(v);
      svg += `<rect class="bar${v < 0 ? " neg" : ""}" x="${x + bw * 0.2}" y="${Math.min(y0, y1)}" width="${bw * 0.6}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="3"/>`;
      svg += `<rect class="hit" data-i="${i}" x="${x}" y="${T}" width="${bw}" height="${H - T - B}"/>`;
    });
    svg += `<line class="zero" x1="${L}" x2="${W - R}" y1="${sy(0)}" y2="${sy(0)}"/></svg>`;
    el.innerHTML = svg;
    el.querySelectorAll(".hit").forEach((h) => {
      const i = +h.dataset.i;
      h.addEventListener("mousemove", (e) => showTip(e, `<div class="t">FY${esc(labels[i])}</div><div class="r"><span>Value</span><b>${esc(fmt(vals[i]))}</b></div>`));
      h.addEventListener("mouseleave", hideTip);
    });
  }

  // Small line chart with optional shaded band (fair-value range) and reference line.
  function miniLine(el, labels, values, fmt, opts = {}) {
    const W = Math.max(220, el.clientWidth), H = opts.h || 150, L = 50, R = 8, T = 10, B = 22;
    const present = values.filter((v) => v != null);
    if (present.length < 2) { el.innerHTML = `<p class="hint">${esc(opts.empty || "Not enough data yet")}</p>`; return; }
    const extra = opts.band ? [opts.band[0], opts.band[1]] : [];
    if (opts.ref != null) extra.push(opts.ref);
    let lo = Math.min(...present, ...extra), hi = Math.max(...present, ...extra);
    if (opts.zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    const nt = niceTicks(lo, hi, 4);
    const sx = (i) => L + (i / (values.length - 1)) * (W - L - R);
    const sy = (v) => T + (1 - (v - nt.lo) / (nt.hi - nt.lo || 1)) * (H - T - B);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    for (const t of nt.ticks) svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text x="${L - 6}" y="${sy(t) + 4}" text-anchor="end">${esc(fmt(t, true))}</text>`;
    if (opts.band) {
      const [a, b] = opts.band;
      svg += `<rect class="band" x="${L}" width="${W - L - R}" y="${sy(b)}" height="${Math.max(1, sy(a) - sy(b))}"/>`;
    }
    if (opts.ref != null) svg += `<line class="refline" x1="${L}" x2="${W - R}" y1="${sy(opts.ref)}" y2="${sy(opts.ref)}"/><text class="reflabel" x="${W - R - 4}" y="${sy(opts.ref) - 5}" text-anchor="end">${esc(opts.refLabel || "")}</text>`;
    const step = Math.max(1, Math.ceil(labels.length / 5));
    labels.forEach((lab, i) => {
      if (i % step && i !== labels.length - 1) return;
      if (i !== labels.length - 1 && labels.length - 1 - i < step / 2) return; // keep clear of the last label
      const anchor = i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle";
      svg += `<text x="${sx(i)}" y="${H - 6}" text-anchor="${anchor}">${esc(lab)}</text>`;
    });
    let d = "";
    values.forEach((v, i) => { if (v == null) return; d += `${d ? "L" : "M"}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`; });
    svg += `<path class="line" d="${d}"/>`;
    const lastI = values.map((v, i) => (v == null ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
    svg += `<circle class="dot" cx="${sx(lastI)}" cy="${sy(values[lastI])}" r="4"/>`;
    const bw = (W - L - R) / Math.max(1, values.length - 1);
    values.forEach((v, i) => { if (v != null) svg += `<rect class="hit" data-i="${i}" x="${sx(i) - bw / 2}" y="${T}" width="${bw}" height="${H - T - B}"/>`; });
    svg += `</svg>`;
    el.innerHTML = svg;
    el.querySelectorAll(".hit").forEach((h) => {
      const i = +h.dataset.i;
      h.addEventListener("mousemove", (e) => showTip(e, `<div class="t">${esc(opts.tipLabel ? opts.tipLabel(i) : labels[i])}</div><div class="r"><span>${esc(opts.name || "Value")}</span><b>${esc(fmt(values[i]))}</b></div>`));
      h.addEventListener("mouseleave", hideTip);
    });
  }

  const fmtM = (v, axis) => {
    if (v == null) return "—";
    const a = Math.abs(v);
    const s = a >= 1e6 ? (v / 1e6).toFixed(axis ? 0 : 1) + "T" : a >= 1e3 ? (v / 1e3).toFixed(axis ? 0 : 1) + "B" : v.toFixed(0) + "M";
    return (v < 0 ? "−$" : "$") + s.replace("-", "");
  };
  const fmtP = (v) => (v == null ? "—" : `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(Math.abs(v) >= 10 ? 0 : 1)}%`);
  const fmtD = (v) => (v == null ? "—" : "$" + fmtNum(v, v >= 100 ? 0 : 2));

  async function openDetail(sym) {
    const s = bySym.get(sym);
    if (!s) return;
    hideExplain();
    const lt = s.lt && s.lt.score != null ? s.lt : null;
    const n = lt ? ltNarrative(s) : null;
    const sig = ltSig(s);
    const h = P && P.held.get(sym);
    const sec = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${s.lt && s.lt.cik ? s.lt.cik : encodeURIComponent(sym)}&type=10-K&dateb=&owner=include&count=40`;
    const statusIcon = (m) => (m.length > 5 ? `<span class="st skip" title="not used">–</span>` : m[2] == null ? `<span class="st na" title="no data">?</span>` : m[2] === m[3] ? `<span class="st full" title="full points">✓</span>` : m[2] > 0 ? `<span class="st half" title="half points">½</span>` : `<span class="st zero" title="no points">✗</span>`);
    const metricRows = lt ? LT_CATS.map(([c, name]) => {
      const rows = lt.m.filter((m) => m[1] === c);
      return `<tr class="grp"><th class="l" colspan="2">${name}</th><th>${lt.cats[c][1] ? `${fmtNum(lt.cats[c][0], 1)} / ${lt.cats[c][1]}` : "n/a"}</th></tr>` +
        rows.map((m) => `<tr class="${m.length > 5 ? "skip" : ""}"><td>${statusIcon(m)}</td><td class="l">${esc(m[4])}</td><td>${m.length > 5 ? "not used" : m[2] == null ? "no data" : `${fmtNum(m[2], m[2] % 1 ? 1 : 0)} / ${m[3]}`}</td></tr>`).join("");
    }).join("") : "";

    $("detail-body").innerHTML = `
      <header class="d-head">
        <div>
          <h2 id="d-title">${esc(s.symbol)} <span>${esc(s.name)}</span></h2>
          <p class="hint">${esc(s.sector)} · ${fmtCap(s.marketCap)} · $${fmtNum(s.price, 2)} on ${esc(state.data.asOf)}${h ? ` · you own ${fmtNum(h.shares, h.shares % 1 ? 2 : 0)} shares (${fmtNum(h.weight, 1)}%)` : ""}</p>
          <p class="d-links"><a href="${yahoo(sym)}" target="_blank" rel="noopener">Yahoo Finance ↗</a><a href="${sec}" target="_blank" rel="noopener">SEC filings ↗</a></p>
        </div>
        <button type="button" class="d-close btn" autofocus>Close</button>
      </header>
      ${lt ? `
      <div class="d-grid">
        <section class="d-card d-score">
          <div class="ex-head">${sig ? `<span class="badge ${sig.kind}">${LT_SIGNALS[sig.kind].label}</span>` : ""}</div>
          <div class="ex-score"><b>${fmtNum(lt.score, 0)}</b><span>/100 · ${ltClass(lt.score)}</span></div>
          <div class="d-subs">
            <div><span>Quality</span><b>${fmtNum(lt.quality, 0)}</b></div>
            <div><span>Value</span><b>${fmtNum(lt.value, 0)}</b></div>
            <div><span>Portfolio fit</span><b>${s.fit == null ? "—" : fmtNum(s.fit, 0)}</b></div>
          </div>
          <div class="cats">${catBars(lt)}</div>
          ${lt.flags.length ? `<p class="d-flags"><span class="badge risk">Red flags</span> ${lt.flags.map(esc).join("; ")}</p>` : ""}
          ${lt.warns.length ? `<p class="d-flags"><span class="badge trim">Note</span> ${lt.warns.map(esc).join("; ")}</p>` : ""}
        </section>
        <section class="d-card">
          <h3>Price vs. fair value</h3>
          <p class="hint">Weekly closes, past year${lt.fv ? ` · shaded = bear $${fmtNum(lt.fv[0], 2)} to bull $${fmtNum(lt.fv[2], 2)} · dashed = base $${fmtNum(lt.fv[1], 2)}` : ""}</p>
          <div class="chart" id="d-price"></div>
        </section>
        <section class="d-card">
          <h3>Long-term score history</h3>
          <p class="hint">One reading per week</p>
          <div class="chart" id="d-hist"></div>
        </section>
        <section class="d-card d-wide">
          <h3>Financials by fiscal year</h3>
          <div class="d-fin">
            <figure><figcaption>Revenue</figcaption><div class="chart" id="d-rev"></div></figure>
            <figure><figcaption>Free cash flow</figcaption><div class="chart" id="d-fcf"></div></figure>
            <figure><figcaption>Operating margin</figcaption><div class="chart" id="d-opm"></div></figure>
            <figure><figcaption>${esc(lt.fin ? lt.fin.roicLabel : "ROIC")}</figcaption><div class="chart" id="d-roic"></div></figure>
          </div>
        </section>
        <section class="d-card d-wide d-story">
          <h3>Investment thesis</h3>
          <p class="ex-k">1. Is it a good business?</p><p>${n.business}</p>
          <p class="ex-k">2. Is it a good price?</p><p>${n.pricePara}</p>
          <p class="ex-k">3. Is now a good time?</p><p>${n.timing}</p>
          <p class="ex-k">What to do</p><p>${n.plan}</p>
          ${n.mine ? `<p class="ex-k">Your portfolio</p><p>${n.mine}</p>` : ""}
          <p class="ex-k">What would change this</p><p>${n.changes.map(esc).join("; ")}.</p>
        </section>
        <section class="d-card d-wide">
          <h3>Every metric</h3>
          <p class="hint">✓ full points · ½ half · ✗ none · ? no data · – not used for this company</p>
          <div class="table-wrap"><table class="d-metrics"><tbody>${metricRows}</tbody></table></div>
        </section>
      </div>
      <p class="ex-note">${ltNote(lt)}</p>` : `
      <div class="d-grid">
        <section class="d-card d-wide">
          <h3>Price, past year</h3>
          <div class="chart" id="d-price"></div>
          <p class="hint">There isn't enough recent US-GAAP filing data to score this company for the long term (common for foreign filers, new listings and some funds).</p>
        </section>
      </div>`}`;

    // Tooltips must live inside the dialog to appear above it.
    detail.appendChild(tip);
    if (!detail.open) detail.showModal();
    detail.scrollTop = 0;

    // Weekly price labels: count back from the last close.
    const asOf = new Date(state.data.asOf + "T00:00:00");
    const spark = s.spark || [];
    const weekLabel = (i, long) => {
      const d = new Date(asOf);
      d.setDate(d.getDate() - 7 * (spark.length - 1 - i));
      return d.toLocaleDateString(undefined, long ? { month: "short", day: "numeric", year: "numeric" } : { month: "short" });
    };
    miniLine($("d-price"), spark.map((_, i) => weekLabel(i)), spark, fmtD, {
      h: 180, name: "Close", tipLabel: (i) => "Week of " + weekLabel(i, true),
      band: lt && lt.fv ? [lt.fv[0], lt.fv[2]] : null, ref: lt && lt.fv ? lt.fv[1] : null, refLabel: lt && lt.fv ? "fair value" : "",
    });
    if (!lt) return;
    const f = lt.fin || { fy: [], rev: [], fcf: [], opm: [], roic: [] };
    miniBars($("d-rev"), f.fy, f.rev, fmtM);
    miniBars($("d-fcf"), f.fy, f.fcf, fmtM);
    miniLine($("d-opm"), f.fy, f.opm, fmtP, { zero: true, name: "Operating margin" });
    miniLine($("d-roic"), f.fy, f.roic, fmtP, { zero: true, ref: 15, refLabel: "15% target", name: f.roicLabel });
    const hist = await loadHistory();
    const col = hist.scores[sym] || [];
    const dates = hist.dates.slice(-col.length);
    miniLine($("d-hist"), dates.map((d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })), col, (v) => fmtNum(v, 0), {
      name: "Score", empty: `History starts ${hist.dates[0] || "this week"}; a line appears after the second weekly reading.`,
    });
  }
  function closeDetail() {
    hideTip();
    document.body.appendChild(tip);
    if (detail.open) detail.close();
  }

  // ---------- data pipeline ----------
  function filtered() {
    const q = state.q.trim().toLowerCase();
    return state.data.stocks.filter(
      (s) =>
        (!state.sector || s.sector === state.sector) &&
        (!state.setup || matchesSignal(s, state.setup)) &&
        s.marketCap >= state.cap &&
        (!q || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    );
  }
  function matchesSignal(s, want) {
    const sig = sigOf(s);
    if (want === "held") return !!(P && P.held.has(s.symbol));
    if (!sig) return false;
    if (want === "hold") return sig.kind === "hold" || sig.kind === "holdOwned";
    return want === "buy" ? sig.tone === "buy" : sig.kind === want;
  }
  function byMetric(rows, key, dir = -1) {
    return rows
      .filter((s) => s[key] != null)
      .sort((a, b) => {
        // dir -1 = descending, 1 = ascending
        const av = a[key], bv = b[key];
        return typeof av === "string" ? dir * av.localeCompare(bv) : dir * (av - bv);
      });
  }

  // ---------- render: tiles ----------
  function renderTiles(rows) {
    const m = state.metric;
    const vals = rows.map((s) => s[m]).filter((v) => v != null);
    const med = median(vals);
    const top = byMetric(rows, m)[0];
    const tiles = [
      { label: "Stocks in view", value: rows.length.toLocaleString(), note: `of ${state.data.count.toLocaleString()} tracked` },
      { label: `Median ${METRICS[m].label.toLowerCase()}`, value: med == null ? "—" : fmtMetric(m, med), cls: METRICS[m].pct ? retClass(med) : "" },
    ];
    if (METRICS[m].pct) {
      const up = vals.filter((v) => v > 0).length;
      tiles.push({ label: "Share with gains", value: vals.length ? Math.round((up / vals.length) * 100) + "%" : "—", note: `${up.toLocaleString()} up · ${(vals.length - up).toLocaleString()} flat or down` });
    } else {
      tiles.push({ label: "Score ≥ 90", value: vals.filter((v) => v >= 90).length.toLocaleString(), note: "consistently strong across windows" });
    }
    if (state.horizon === "long") {
      const count = (k) => rows.filter((s) => s.lt && s.lt.signal === k).length;
      const nbuy = count("buy");
      tiles.splice(2, 1, { label: "Scored", value: rows.filter((s) => s.lts != null).length.toLocaleString(), note: "with enough SEC filing data" });
      tiles.push({ label: "Buy review", value: nbuy.toLocaleString(), cls: nbuy ? "up" : "", note: `${count("watch").toLocaleString()} on the watchlist · ${count("risk").toLocaleString()} risk reviews` });
    } else {
      const buys = rows.filter((s) => s.setup && s.setup.kind !== "hot");
      const nb = buys.filter((s) => s.setup.kind === "breakout").length;
      tiles.push({ label: "Setups for next open", value: buys.length.toLocaleString(), cls: buys.length ? "up" : "", note: `${nb} breakout · ${buys.length - nb} buy the dip` });
    }
    tiles.push({ label: state.horizon === "long" ? "Top ranked" : "Top performer", value: top ? top.symbol : "—", note: top ? `${fmtMetric(m, top[m])} · ${top.name}` : "" });
    $("tiles").innerHTML = tiles
      .map((t) => `<div class="tile"><div class="label">${esc(t.label)}</div><div class="value ${t.cls || ""}">${esc(t.value)}</div>${t.note ? `<div class="note">${esc(t.note)}</div>` : ""}</div>`)
      .join("");
  }

  // ---------- render: horizontal bar chart ----------
  function barChart(el, items, opts) {
    const width = Math.max(280, el.clientWidth);
    const rowH = 22, top = 8, bottom = 24, labelW = opts.labelW || 56, right = 12;
    const height = top + bottom + Math.max(1, items.length) * rowH;
    if (!items.length) {
      el.innerHTML = `<svg viewBox="0 0 ${width} 60" role="img" aria-label="No data"><text class="empty" x="${width / 2}" y="34" text-anchor="middle">No stocks match these filters</text></svg>`;
      return;
    }
    const values = items.map((d) => d.value);
    const refs = opts.ref != null ? [opts.ref] : [];
    const { ticks, lo, hi } = niceTicks(Math.min(0, ...values, ...refs), Math.max(0, ...values, ...refs), Math.max(2, Math.floor((width - labelW) / 90)));
    const x0 = labelW, x1 = width - right;
    const sx = (v) => x0 + ((v - lo) / (hi - lo || 1)) * (x1 - x0);
    const zero = sx(0);
    const plotBottom = height - bottom;
    let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.aria)}">`;
    for (const t of ticks) {
      const x = sx(t);
      svg += `<line class="grid-line" x1="${x}" x2="${x}" y1="${top}" y2="${plotBottom}"/>`;
      svg += `<text x="${x}" y="${height - 8}" text-anchor="middle">${esc(opts.tickFmt(t))}</text>`;
    }
    items.forEach((d, i) => {
      const y = top + i * rowH;
      const bh = rowH - 6;
      const xa = Math.min(zero, sx(d.value)), w = Math.max(1, Math.abs(sx(d.value) - zero));
      // 4px rounding only on the data end; the baseline end stays square.
      const r = Math.min(4, w / 2, bh / 2);
      const neg = d.value < 0;
      const path = neg
        ? `M${xa + w},${y + 3} H${xa + r} Q${xa},${y + 3} ${xa},${y + 3 + r} V${y + 3 + bh - r} Q${xa},${y + 3 + bh} ${xa + r},${y + 3 + bh} H${xa + w} Z`
        : `M${xa},${y + 3} H${xa + w - r} Q${xa + w},${y + 3} ${xa + w},${y + 3 + r} V${y + 3 + bh - r} Q${xa + w},${y + 3 + bh} ${xa + w - r},${y + 3 + bh} H${xa} Z`;
      svg += `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(d.label)}</text>`;
      svg += `<path class="bar${neg && opts.diverging ? " neg" : ""}" d="${path}"/>`;
      svg += `<rect class="hit" data-i="${i}" x="0" y="${y}" width="${width}" height="${rowH}"/>`;
    });
    if (opts.ref != null) svg += `<line class="refline" x1="${sx(opts.ref)}" x2="${sx(opts.ref)}" y1="${top}" y2="${plotBottom}"/>`;
    svg += `<line class="zero" x1="${zero}" x2="${zero}" y1="${top}" y2="${plotBottom}"/></svg>`;
    el.innerHTML = svg;
    el.querySelectorAll(".hit").forEach((h) => {
      const d = items[+h.dataset.i];
      h.addEventListener("mousemove", (e) => showTip(e, opts.tip(d)));
      h.addEventListener("mouseleave", hideTip);
      if (d.href) {
        h.style.cursor = "pointer";
        h.addEventListener("click", () => window.open(d.href, "_blank", "noopener"));
      }
    });
  }

  function renderCharts(rows) {
    const m = state.metric, meta = METRICS[m];
    const top = byMetric(rows, m).slice(0, 20);
    $("top-title").textContent = `Top ${top.length} by ${meta.label.toLowerCase()}`;
    barChart($("chart-top"), top.map((s) => ({ label: s.symbol, value: s[m], stock: s, href: yahoo(s.symbol) })), {
      aria: `Top stocks by ${meta.label}`,
      tickFmt: (t) => (meta.pct ? (t > 0 ? "+" : t < 0 ? "−" : "") + Math.abs(t).toLocaleString() + "%" : t.toLocaleString()),
      tip: (d) => stockTip(d.stock),
    });

    const groups = {};
    for (const s of rows) if (s[m] != null) (groups[s.sector] = groups[s.sector] || []).push(s[m]);
    const sectors = Object.entries(groups)
      .map(([name, v]) => ({ label: name, value: median(v), n: v.length }))
      .sort((a, b) => b.value - a.value);
    $("sector-title").textContent = `Median ${meta.label.toLowerCase()} by sector`;
    barChart($("chart-sector"), sectors.map((d) => ({ ...d, label: d.label.length > 22 ? d.label.slice(0, 21) + "…" : d.label, full: d.label })), {
      aria: `Median ${meta.label} by sector`,
      labelW: 150,
      diverging: meta.pct,
      tickFmt: (t) => (meta.pct ? (t > 0 ? "+" : t < 0 ? "−" : "") + Math.abs(t).toLocaleString() + "%" : t.toLocaleString()),
      tip: (d) => `<div class="t">${esc(d.full)}</div><div class="r"><span>Median ${meta.short}</span><b>${fmtMetric(m, d.value)}</b></div><div class="r"><span>Stocks</span><b>${d.n.toLocaleString()}</b></div>`,
    });
  }

  // ---------- render: table ----------
  function yahoo(sym) {
    return "https://finance.yahoo.com/quote/" + encodeURIComponent(sym.replace("/", "-"));
  }
  function sparkline(vals) {
    if (!vals || vals.length < 2) return "";
    const w = 90, h = 24, p = 2;
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * (w - 2 * p) + p).toFixed(1)},${(h - p - ((v - lo) / span) * (h - 2 * p)).toFixed(1)}`).join(" ");
    const neg = vals[vals.length - 1] < vals[0];
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline class="spark${neg ? " neg" : ""}" points="${pts}"/></svg>`;
  }

  function syncSignalOptions() {
    const opts = state.horizon === "long"
      ? [["", "All stocks"], ["held", "My holdings"], ["buy", "Buy review / Accumulate"], ["watch", "Watchlist"], ["hold", "Hold"], ["trim", "Trim review"], ["exit", "Exit review (owned)"], ["avoid", "Avoid"], ["risk", "Risk review"]]
      : [["", "All stocks"], ["held", "My holdings"], ["buy", "Setups for next open"], ["breakout", "Breakouts"], ["dip", "Buy the dip"], ["hot", "Too hot (avoid chasing)"]];
    $("f-setup").innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    $("f-setup").value = state.setup;
  }
  const visibleColumns = () => COLUMNS.filter((c) => (!c.only || c.only === state.horizon) && (!c.need || c.need()));

  function renderTable(rows) {
    const COLUMNS = visibleColumns();
    const key = state.sortKey || state.metric;
    const dir = state.sortKey ? state.sortDir : -1;
    let sorted = byMetric(rows, key, dir);
    if (state.limit) sorted = sorted.slice(0, state.limit);
    $("table-title").textContent = `${state.limit ? "Top " + sorted.length : "All " + sorted.length.toLocaleString()} by ${(COLUMNS.find((c) => c.key === key) || {}).label || key}${dir === 1 ? " (ascending)" : ""}`;

    $("table").querySelector("thead tr").innerHTML = COLUMNS.map(
      (c) => `<th class="${c.cls ? c.cls.split(" ")[0] : ""}${c.key === key ? " sorted" : ""}" data-key="${c.key}" ${c.sortable === false ? "" : 'tabindex="0"'} aria-sort="${c.key === key ? (dir === -1 ? "descending" : "ascending") : "none"}">${esc(c.label)}${c.key === key ? (dir === -1 ? " ↓" : " ↑") : ""}</th>`
    ).join("");

    $("table").querySelector("tbody").innerHTML = sorted
      .map((s, i) => {
        const cells = COLUMNS.map((c) => {
          if (c.key === "rank") return `<td class="na">${i + 1}</td>`;
          if (c.key === "spark") return `<td>${sparkline(s.spark)}</td>`;
          if (c.key === "setup") {
            const sig = sigOf(s);
            if (!sig) return `<td class="l"></td>`;
            const k = sig.kind;
            return `<td class="l"><span class="sig"><span class="badge ${k}">${sig.label}</span><button type="button" class="why" data-sym="${esc(s.symbol)}" aria-expanded="false" aria-controls="explain">Why?</button></span></td>`;
          }
          const v = s[c.key];
          if (c.ret) return `<td class="${retClass(v)}">${fmtPct(v)}</td>`;
          if (c.key === "symbol") return `<td class="${c.cls}"><a href="${yahoo(v)}" target="_blank" rel="noopener">${esc(v)}</a>${P && P.held.has(v) ? ` <span class="owned" title="In your portfolio">Owned</span>` : ""}</td>`;
          const text = c.fmt ? c.fmt(v) : v == null ? "—" : v;
          return `<td class="${c.cls || ""}"${c.key === "name" ? ` title="${esc(v)}"` : ""}>${esc(text)}</td>`;
        }).join("");
        const sig = sigOf(s);
        const hl = sig ? (sig.tone === "buy" ? " setup-buy" : sig.tone === "warn" ? " setup-hot" : "") : "";
        return `<tr class="${hl.trim()}" data-sym="${esc(s.symbol)}">${cells}</tr>`;
      })
      .join("");
  }

  function render() {
    const rows = filtered();
    renderTiles(rows);
    renderCharts(rows);
    renderTable(rows);
    renderPortfolio();
  }

  // ---------- wiring ----------
  function bind() {
    $("f-metric").addEventListener("change", (e) => { state.metric = e.target.value; state.sortKey = null; render(); });
    $("f-sector").addEventListener("change", (e) => { state.sector = e.target.value; render(); });
    $("f-cap").addEventListener("change", (e) => { state.cap = +e.target.value; render(); });
    $("f-limit").addEventListener("change", (e) => { state.limit = +e.target.value; render(); });
    let t;
    $("f-search").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value; render(); }, 120); });

    const thead = $("table").querySelector("thead");
    const sortBy = (th) => {
      const k = th.dataset.key;
      const col = COLUMNS.find((c) => c.key === k);
      if (!col || col.sortable === false) return;
      const current = state.sortKey || state.metric;
      if (current === k) state.sortDir = state.sortKey ? -state.sortDir : 1;
      else state.sortDir = col.cls && col.cls.startsWith("l") ? 1 : -1;
      state.sortKey = k;
      renderTable(filtered());
    };
    thead.addEventListener("click", (e) => { const th = e.target.closest("th"); if (th) sortBy(th); });
    thead.addEventListener("keydown", (e) => { const th = e.target.closest("th"); if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sortBy(th); } });
    const tbody = $("table").querySelector("tbody");
    // Hover or focus opens the explanation; a tap toggles it on touch screens.
    tbody.addEventListener("mouseover", (e) => { const b = e.target.closest(".why"); if (b && b !== explainFor) showExplain(b); });
    tbody.addEventListener("mouseout", (e) => {
      // Touch screens fire a synthetic mouseout when the sheet opens under the finger.
      if (sheet.matches) return;
      const b = e.target.closest(".why");
      if (b && !b.contains(e.relatedTarget)) hideExplain();
    });
    tbody.addEventListener("focusin", (e) => { const b = e.target.closest(".why"); if (b) showExplain(b); });
    tbody.addEventListener("focusout", (e) => { if (e.target.closest(".why")) hideExplain(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideExplain(); });
    document.addEventListener("click", (e) => {
      // A tap's click can land on the sheet it just opened; only a later tap outside closes it.
      if (e.target.closest(".why") || e.target.closest("#explain") || Date.now() - explainOpenedAt < 400) return;
      hideExplain();
    });
    window.addEventListener("scroll", placeExplain, { passive: true });
    $("f-setup").addEventListener("change", (e) => { state.setup = e.target.value; render(); });
    $("f-horizon").addEventListener("change", (e) => {
      state.horizon = e.target.value;
      state.setup = "";
      state.sortKey = null;
      // Each horizon opens on its own headline ranking.
      state.metric = state.horizon === "long" ? "lts" : "score";
      $("f-metric").value = state.metric;
      syncSignalOptions();
      hideExplain();
      render();
    });
    tbody.addEventListener("click", (e) => {
      const why = e.target.closest(".why");
      // A tap fires mouseover then click; don't let the click close what the tap just opened.
      if (why) { explainFor === why && Date.now() - explainOpenedAt > 500 ? hideExplain() : showExplain(why); return; }
      if (e.target.closest("a")) return;
      const tr = e.target.closest("tr");
      if (tr && tr.dataset.sym) openDetail(tr.dataset.sym);
    });

    // My portfolio
    $("pf-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const sym = $("pf-sym").value.trim().toUpperCase();
      const shares = +$("pf-shares").value;
      const cost = +$("pf-cost").value || null;
      const msg = $("pf-msg");
      if (!bySym.has(sym)) {
        msg.textContent = `${sym} isn't in today's list (US-listed stocks over $300M). Check the ticker.`;
        msg.className = "pf-msg down";
        return;
      }
      if (!(shares > 0)) {
        msg.textContent = "Enter how many shares you own.";
        msg.className = "pf-msg down";
        return;
      }
      upsertPosition(sym, shares, cost);
      msg.textContent = `Saved ${fmtNum(shares, shares % 1 ? 2 : 0)} ${sym}.`;
      msg.className = "pf-msg up";
      e.target.reset();
      $("pf-sym").focus();
      portfolioChanged();
    });
    $("pf-cash").addEventListener("change", (e) => { pf.cash = Math.max(0, +e.target.value || 0); savePf(); portfolioChanged(); });
    $("pf-body").addEventListener("click", (e) => {
      const rm = e.target.closest(".pf-rm");
      if (rm) {
        pf.positions = pf.positions.filter((p) => p.sym !== rm.dataset.sym);
        savePf();
        $("pf-msg").textContent = `Removed ${rm.dataset.sym}.`;
        $("pf-msg").className = "pf-msg";
        portfolioChanged();
        return;
      }
      const tr = e.target.closest("tbody tr");
      if (tr && tr.dataset.sym && bySym.has(tr.dataset.sym)) openDetail(tr.dataset.sym);
    });

    // Detail view
    detail.addEventListener("click", (e) => {
      if (e.target === detail || e.target.closest(".d-close")) closeDetail();
    });
    detail.addEventListener("close", () => { hideTip(); document.body.appendChild(tip); });

    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => renderCharts(filtered()), 150); });
  }

  async function init() {
    try {
      const embedded = document.getElementById("stocks-data");
      if (embedded) state.data = JSON.parse(embedded.textContent);
      else {
      const res = await fetch("data/stocks.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status + " " + res.statusText);
      state.data = await res.json();
      }
    } catch (err) {
      $("asof").textContent = "Couldn't load data/stocks.json (" + err.message + "). Serve this folder over HTTP, e.g. python -m http.server.";
      return;
    }
    const d = state.data;
    for (const s of d.stocks) {
      bySym.set(s.symbol, s);
      s.setup = setupFor(s);
      const lt = s.lt || {};
      s.lts = lt.score ?? null;
      s.ltq = lt.quality ?? null;
      s.ltv = lt.value ?? null;
      s.mos = lt.mos ?? null;
    }
    if (!d.stocks.some((s) => s.lts != null)) {
      // No fundamentals yet: start on the momentum view.
      state.horizon = "short";
      state.metric = "r1y";
      $("f-horizon").value = "short";
      $("f-metric").value = "r1y";
    }
    loadPf();
    computePf();
    $("pf-syms").innerHTML = d.stocks.map((s) => `<option value="${esc(s.symbol)}">${esc(s.name)}</option>`).join("");
    syncSignalOptions();
    $("asof").textContent = `${d.count.toLocaleString()} US stocks with market cap ≥ ${fmtCap(d.minMarketCap)} · prices as of ${d.asOf} · updated ${new Date(d.generatedAt).toLocaleString()}`;
    $("sample-banner").hidden = !d.sample;
    const sectors = [...new Set(d.stocks.map((s) => s.sector))].sort();
    $("f-sector").insertAdjacentHTML("beforeend", sectors.map((s) => `<option>${esc(s)}</option>`).join(""));
    bind();
    render();
  }

  init();
})();
