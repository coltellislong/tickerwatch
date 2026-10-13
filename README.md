# TickerWatch Growth

A dashboard that ranks US-listed stocks (NASDAQ, NYSE, AMEX) by price growth.
It's meant for viewing only, not investment advice.

- **Rank by** 1W, 1M, 3M, 6M, YTD, 1Y return, or a blended **growth score**: the average percentile rank of the 1M, 3M, 6M and 1Y returns (0–100). It favors stocks that have been strong across every window, not just one spike.
- **Filter** by sector, market cap and ticker/name search. Sort the table by any column. Click a row to open the ticker on Yahoo Finance.
- **Charts:** the top 20 for the chosen window, plus the median return by sector. Every row has a 1-year sparkline.

## How it works

```
scripts/fetch_data.py  ──►  data/stocks.json  ──►  index.html + assets/app.js
 (Nasdaq listing + Yahoo prices)   (one JSON file)     (static page, no build step)
```

`fetch_data.py` pulls every listed stock from Nasdaq's screener and keeps those with a market cap of **$300M or more**. That cutoff drops penny stocks, warrants and preferreds, which would otherwise flood the "top growth" lists with noise. The script then downloads about 13 months of daily closes through `yfinance` and computes the returns.

The **Update stock data** workflow (`.github/workflows/update-data.yml`) runs that script each weekday after the US close and commits the refreshed JSON. You can also run it by hand from the Actions tab.

> The committed `data/stocks.json` starts out as **made-up sample data** (fictional tickers) so the page has something to show. A yellow banner marks it. The first run of the workflow, or of the script locally, replaces it with real data.

## Run locally

```bash
pip install -r requirements.txt
python scripts/fetch_data.py          # real data (needs internet; takes a few minutes)
# or: python scripts/make_sample_data.py   # fictional preview data
python -m http.server 8000            # then open http://localhost:8000
```

Options: `MIN_MARKET_CAP=2000000000` sets a different floor, and `MAX_TICKERS=500` makes a quick test run on the largest names.

## Publish it

1. Merge to the default branch. Scheduled workflows only run there.
2. **Settings → Actions → General → Workflow permissions**: choose *Read and write* so the workflow can commit data.
3. **Settings → Pages**: deploy from the default branch, `/ (root)`.
4. Run **Update stock data** once from the Actions tab to replace the sample data.
