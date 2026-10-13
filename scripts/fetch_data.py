#!/usr/bin/env python3
"""Build data/stocks.json: growth stats for every listed US stock.

1. Pull the full NASDAQ / NYSE / AMEX listing from Nasdaq's public screener.
2. Keep common stocks above a market-cap floor (filters out penny stocks,
   warrants, preferreds, and other noise).
3. Download ~13 months of daily closes from Yahoo Finance via yfinance.
4. Compute trailing returns plus a blended "growth score" and write JSON.

Env vars:
  MIN_MARKET_CAP  minimum market cap in USD (default 300_000_000)
  MAX_TICKERS     cap on universe size, largest first (default: no cap)
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "stocks.json"

SCREENER_URL = "https://api.nasdaq.com/api/screener/stocks"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}
MIN_MARKET_CAP = float(os.environ.get("MIN_MARKET_CAP", 300_000_000))
MAX_TICKERS = int(os.environ.get("MAX_TICKERS", 0)) or None
CHUNK = 200

# Trailing windows in calendar days. YTD is handled separately.
WINDOWS = {"r1w": 7, "r1m": 30, "r3m": 91, "r6m": 182, "r1y": 365}
SCORE_KEYS = ["r1m", "r3m", "r6m", "r1y"]


def to_float(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return float(str(s).replace("$", "").replace(",", "").replace("%", ""))
    except ValueError:
        return None


def fetch_universe() -> list[dict]:
    rows = []
    for exchange in ("nasdaq", "nyse", "amex"):
        params = {"tableonly": "true", "limit": 10000, "download": "true", "exchange": exchange}
        for attempt in range(4):
            try:
                r = requests.get(SCREENER_URL, params=params, headers=HEADERS, timeout=60)
                r.raise_for_status()
                data = r.json()["data"]["rows"]
                break
            except Exception as exc:  # network hiccup / throttling
                if attempt == 3:
                    raise
                print(f"screener {exchange} failed ({exc}); retrying", file=sys.stderr)
                time.sleep(2 ** (attempt + 1))
        for row in data:
            row["exchange"] = exchange.upper()
        rows.extend(data)

    universe = {}
    for row in rows:
        sym = (row.get("symbol") or "").strip()
        cap = to_float(row.get("marketCap"))
        # Skip warrants/units/preferreds (^ or long suffixes) and tiny caps.
        if not sym or "^" in sym or len(sym) > 6 or cap is None or cap < MIN_MARKET_CAP:
            continue
        universe[sym] = {
            "symbol": sym,
            "yahoo": sym.replace("/", "-"),
            "name": (row.get("name") or "").replace(" Common Stock", "").strip(),
            "sector": row.get("sector") or "Other",
            "industry": row.get("industry") or "",
            "exchange": row["exchange"],
            "marketCap": cap,
        }
    stocks = sorted(universe.values(), key=lambda s: s["marketCap"], reverse=True)
    return stocks[:MAX_TICKERS] if MAX_TICKERS else stocks


def download_closes(symbols: list[str], start: str) -> pd.DataFrame:
    frames = []
    for i in range(0, len(symbols), CHUNK):
        batch = symbols[i : i + CHUNK]
        print(f"prices {i + 1}-{i + len(batch)} of {len(symbols)}", file=sys.stderr)
        df = yf.download(
            batch, start=start, interval="1d", auto_adjust=True,
            progress=False, threads=True, group_by="column",
        )
        if df.empty:
            continue
        close = df["Close"]
        if isinstance(close, pd.Series):  # single-ticker batch
            close = close.to_frame(batch[0])
        frames.append(close)
    return pd.concat(frames, axis=1) if frames else pd.DataFrame()


def pct(now: float, then: float | None) -> float | None:
    if then is None or not then or math.isnan(then) or math.isnan(now):
        return None
    return round((now / then - 1) * 100, 2)


def close_on_or_before(series: pd.Series, when: pd.Timestamp) -> float | None:
    s = series.loc[:when]
    return float(s.iloc[-1]) if len(s) else None


def main() -> None:
    stocks = fetch_universe()
    print(f"universe: {len(stocks)} stocks >= ${MIN_MARKET_CAP:,.0f}", file=sys.stderr)

    start = (datetime.now(timezone.utc) - timedelta(days=400)).strftime("%Y-%m-%d")
    closes = download_closes([s["yahoo"] for s in stocks], start)
    closes.index = pd.to_datetime(closes.index).tz_localize(None)

    out = []
    for s in stocks:
        if s["yahoo"] not in closes:
            continue
        series = closes[s["yahoo"]].dropna()
        if len(series) < 20:
            continue
        last_day, last = series.index[-1], float(series.iloc[-1])
        rec = {k: v for k, v in s.items() if k != "yahoo"}
        rec["price"] = round(last, 2)
        for key, days in WINDOWS.items():
            # Only report a window when we actually have history that far back.
            when = last_day - pd.Timedelta(days=days)
            rec[key] = pct(last, close_on_or_before(series, when)) if series.index[0] <= when else None
        prev_year_end = pd.Timestamp(year=last_day.year - 1, month=12, day=31)
        rec["rytd"] = pct(last, close_on_or_before(series, prev_year_end)) if series.index[0] <= prev_year_end else None
        weekly = series.resample("W-FRI").last().dropna().tail(53)
        rec["spark"] = [round(float(v), 2) for v in weekly]
        out.append(rec)

    # Growth score: mean percentile rank across 1M/3M/6M/1Y (0-100).
    df = pd.DataFrame(out)
    ranks = df[SCORE_KEYS].rank(pct=True)
    score = ranks.mean(axis=1, skipna=True) * 100
    for rec, sc, n in zip(out, score, ranks.notna().sum(axis=1)):
        rec["score"] = round(float(sc), 1) if n >= 3 else None

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "asOf": closes.index[-1].strftime("%Y-%m-%d"),
        "sample": False,
        "minMarketCap": MIN_MARKET_CAP,
        "count": len(out),
        "stocks": out,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {len(out)} stocks to {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
