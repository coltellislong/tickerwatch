(() => {
  "use strict";

  const METRICS = {
    score: { label: "Growth score", short: "Score", pct: false },
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
    ...["r1w", "r1m", "r3m", "r6m", "rytd", "r1y"].map((k) => ({ key: k, label: METRICS[k].short, ret: true })),
    { key: "score", label: "Score", fmt: (v) => fmtNum(v, 0) },
    { key: "spark", label: "1Y trend", sortable: false },
  ];

  const $ = (id) => document.getElementById(id);
  const state = { data: null, metric: "r1y", sector: "", cap: 0, limit: 50, q: "", sortKey: null, sortDir: -1, setup: "" };

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

  const explainBox = $("explain");
  let explainFor = null;
  let explainOpenedAt = 0;
  function showExplain(btn) {
    const s = state.data.stocks.find((x) => x.symbol === btn.dataset.sym);
    if (!s || !s.setup) return;
    const u = s.setup;
    const buy = u.kind !== "hot";
    explainBox.innerHTML = `
      <div class="ex-head"><span class="badge ${u.kind}">${SETUP_LABELS[u.kind]}</span><b>${esc(s.symbol)}</b><span class="ex-name">${esc(s.name)}</span></div>
      <p class="ex-k">What it saw</p><p>${esc(u.saw)}</p>
      <p class="ex-k">${buy ? "Why it might keep going" : "Why it's a warning"}</p><p>${esc(u.why)}</p>
      <p class="ex-k">${buy ? "How long to stay in" : "What to do"}</p><p>${esc(u.hold)}</p>
      ${u.exit ? `<p class="ex-k">When to leave</p><p>${esc(u.exit)}</p>` : ""}
      <p class="ex-note">A simple rule applied to the ${esc(state.data.asOf)} closing prices, not a prediction or financial advice. Prices can jump or drop at the open. Only invest money you can afford to lose.</p>`;
    explainBox.hidden = false;
    explainFor = btn;
    explainOpenedAt = Date.now();
    btn.setAttribute("aria-expanded", "true");
    placeExplain();
  }
  function placeExplain() {
    if (!explainFor) return;
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

  // ---------- data pipeline ----------
  function filtered() {
    const q = state.q.trim().toLowerCase();
    return state.data.stocks.filter(
      (s) =>
        (!state.sector || s.sector === state.sector) &&
        (!state.setup || (state.setup === "buy" ? s.setup && s.setup.kind !== "hot" : s.setup && s.setup.kind === state.setup)) &&
        s.marketCap >= state.cap &&
        (!q || s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
    );
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
    const buys = rows.filter((s) => s.setup && s.setup.kind !== "hot");
    const nb = buys.filter((s) => s.setup.kind === "breakout").length;
    tiles.push({ label: "Setups for next open", value: buys.length.toLocaleString(), cls: buys.length ? "up" : "", note: `${nb} breakout · ${buys.length - nb} buy the dip` });
    tiles.push({ label: "Top performer", value: top ? top.symbol : "—", note: top ? `${fmtMetric(m, top[m])} · ${top.name}` : "" });
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
    const { ticks, lo, hi } = niceTicks(Math.min(0, ...values), Math.max(0, ...values), Math.max(2, Math.floor((width - labelW) / 90)));
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

  function renderTable(rows) {
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
            if (!s.setup) return `<td class="l"></td>`;
            const k = s.setup.kind;
            return `<td class="l"><span class="sig"><span class="badge ${k}">${SETUP_LABELS[k]}</span><button type="button" class="why" data-sym="${esc(s.symbol)}" aria-expanded="false" aria-controls="explain">Why?</button></span></td>`;
          }
          const v = s[c.key];
          if (c.ret) return `<td class="${retClass(v)}">${fmtPct(v)}</td>`;
          if (c.key === "symbol") return `<td class="${c.cls}"><a href="${yahoo(v)}" target="_blank" rel="noopener">${esc(v)}</a></td>`;
          const text = c.fmt ? c.fmt(v) : v == null ? "—" : v;
          return `<td class="${c.cls || ""}"${c.key === "name" ? ` title="${esc(v)}"` : ""}>${esc(text)}</td>`;
        }).join("");
        const hl = s.setup ? (s.setup.kind === "hot" ? " setup-hot" : " setup-buy") : "";
        return `<tr class="${hl.trim()}" data-sym="${esc(s.symbol)}">${cells}</tr>`;
      })
      .join("");
  }

  function render() {
    const rows = filtered();
    renderTiles(rows);
    renderCharts(rows);
    renderTable(rows);
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
    tbody.addEventListener("mouseout", (e) => { const b = e.target.closest(".why"); if (b && !b.contains(e.relatedTarget)) hideExplain(); });
    tbody.addEventListener("focusin", (e) => { const b = e.target.closest(".why"); if (b) showExplain(b); });
    tbody.addEventListener("focusout", (e) => { if (e.target.closest(".why")) hideExplain(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideExplain(); });
    document.addEventListener("click", (e) => { if (!e.target.closest(".why")) hideExplain(); });
    window.addEventListener("scroll", placeExplain, { passive: true });
    $("f-setup").addEventListener("change", (e) => { state.setup = e.target.value; render(); });
    tbody.addEventListener("click", (e) => {
      const why = e.target.closest(".why");
      // A tap fires mouseover then click; don't let the click close what the tap just opened.
      if (why) { explainFor === why && Date.now() - explainOpenedAt > 500 ? hideExplain() : showExplain(why); return; }
      if (e.target.closest("a")) return;
      const tr = e.target.closest("tr");
      if (tr) window.open(yahoo(tr.dataset.sym), "_blank", "noopener");
    });

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
    for (const s of d.stocks) s.setup = setupFor(s);
    $("asof").textContent = `${d.count.toLocaleString()} US stocks with market cap ≥ ${fmtCap(d.minMarketCap)} · prices as of ${d.asOf} · updated ${new Date(d.generatedAt).toLocaleString()}`;
    $("sample-banner").hidden = !d.sample;
    const sectors = [...new Set(d.stocks.map((s) => s.sector))].sort();
    $("f-sector").insertAdjacentHTML("beforeend", sectors.map((s) => `<option>${esc(s)}</option>`).join(""));
    bind();
    render();
  }

  init();
})();
