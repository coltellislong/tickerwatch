#!/usr/bin/env python3
"""Write placeholder data/stocks.json with FICTIONAL tickers for local preview.

The dashboard shows a "sample data" banner whenever `sample` is true. Run
scripts/fetch_data.py (or the GitHub Action) to replace it with real data.
"""
import json
import random
from datetime import date, datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "stocks.json"
SECTORS = ["Technology", "Health Care", "Finance", "Consumer Discretionary",
           "Industrials", "Energy", "Utilities", "Real Estate", "Basic Materials",
           "Telecommunications", "Consumer Staples"]
rng = random.Random(42)


def main():
    stocks, used = [], set()
    while len(stocks) < 800:
        sym = "".join(rng.choice("ABCDEFGHIJKLMNOPQRSTUVWXYZ") for _ in range(rng.choice([3, 4])))
        if sym in used:
            continue
        used.add(sym)
        drift, vol = rng.gauss(0.002, 0.006), rng.uniform(0.02, 0.09)
        px = [rng.uniform(5, 400)]
        for _ in range(52):
            px.append(max(0.5, px[-1] * (1 + rng.gauss(drift, vol))))
        last = px[-1]
        r = lambda w: round((last / px[-1 - w] - 1) * 100, 2)
        stocks.append({
            "symbol": sym, "name": f"Sample Co {sym}", "sector": rng.choice(SECTORS),
            "industry": "", "exchange": rng.choice(["NASDAQ", "NYSE"]),
            "marketCap": round(10 ** rng.uniform(8.5, 12.3)), "price": round(last, 2),
            "r1w": r(1), "r1m": r(4), "r3m": r(13), "r6m": r(26), "rytd": r(40), "r1y": r(52),
            "spark": [round(p, 2) for p in px],
        })
    keys = ["r1m", "r3m", "r6m", "r1y"]
    for k in keys:
        order = sorted(stocks, key=lambda s: s[k])
        for i, s in enumerate(order):
            s.setdefault("_rk", []).append((i + 1) / len(order))
    for s in stocks:
        s["score"] = round(sum(s.pop("_rk")) / len(keys) * 100, 1)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "asOf": date.today().isoformat(), "sample": True, "minMarketCap": 300_000_000,
        "count": len(stocks), "stocks": stocks,
    }, separators=(",", ":")))
    print(f"wrote {len(stocks)} sample stocks to {OUT}")


if __name__ == "__main__":
    main()
