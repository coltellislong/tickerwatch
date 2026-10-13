# TickerWatch Growth

A dashboard that ranks US-listed stocks (NASDAQ, NYSE, AMEX) two ways: a **long-term** view that scores the business and its price from SEC filings, and a **short-term** view of price momentum.
It's meant for research, not investment advice.

- **Rank by** 1W, 1M, 3M, 6M, YTD, 1Y return, or a blended **growth score**: the average percentile rank of the 1M, 3M, 6M and 1Y returns (0–100). It favors stocks that have been strong across every window, not just one spike.
- **Filter** by sector, market cap and ticker/name search. Sort the table by any column. Click a row to open the ticker on Yahoo Finance.
- **Charts:** the top 20 for the chosen window, plus the median return by sector. Every row has a 1-year sparkline.

## Long-term score (default view)

Every stock with enough SEC filing data gets a 0–100 score from six categories, plus three plain-language answers: *Is it a good business? Is it a good price? Is now a good time?*

| Category | Points | What's measured (annual 10-K data) |
|---|---|---|
| Financial quality | 25 | 5-yr median ROIC ≥ 15%, positive free cash flow 4 of 5 yrs, stable/rising operating margin, 3-yr ROE ≥ 15% without heavy leverage, FCF/net income ≥ 80%, profitable 4 of 5 yrs |
| Growth | 20 | 3-yr revenue CAGR ≥ 10%, EPS CAGR ≥ 10%, FCF/share CAGR ≥ 8%, share count growth ≤ 1%/yr |
| Valuation | 20 | P/E ≤ 80% and EV/EBITDA ≤ 85% of the sector median, FCF yield ≥ 5%, PEG ≤ 1.5, price ≥ 25% below DCF fair value |
| Competitive strength | 15 | proxies: ROIC ≥ 15% in 4 of 5 yrs, revenue rank in sector, gross margin ≥ 40% and steady, ROIC with no dilution |
| Risk & balance sheet | 10 | net debt/EBITDA < 2, interest coverage > 5, current ratio ≥ 1.5 or net cash |
| Trend | 10 | price > 200-day, 50-day > 200-day, RSI 40–65, weekly MACD > 0, 6-month return beats sector median |

Each metric earns full, half or zero points. Metrics that need paid or hand-gathered data (analyst forecasts and revisions, customer retention and concentration, governance) are marked n/a and the category is re-weighted over what remains. Banks and insurers skip cash-flow and EBITDA measures and use price/book and earnings yield instead.

**Fair value** is a 10-year DCF on the 3-year average free cash flow (net income for financials): five years at the recent revenue growth rate (capped at −5%…20%), five years fading to 2.5% terminal growth, discounted at 9% (+1% for small caps or high debt). Bear and bull cases halve or stretch growth and move the discount rate.

| Signal | Rule |
|---|---|
| **Buy review** | score ≥ 85, valuation ≥ 14/20, price ≥ 20% below fair value, no red flags |
| **Watchlist** | score ≥ 75 but not a buy; shows an entry price 20% below fair value |
| **Hold / fair** | score 60–74 |
| **Trim review** | score ≥ 60 but price 60%+ above fair value |
| **Avoid** | score below 60 |
| **Risk review** | any red flag: interest coverage < 1.5×, net debt > 5× EBITDA, revenue down 3 years running, share count up > 10%/yr, negative FCF 3 years running, or a stale annual report |

The thresholds are starting defaults and haven't been backtested. The score ranks stocks; it is not a probability of making money. Scoring lives in `scripts/score.py`.

## 1-year horizon

A middle view for roughly 12-month holdings. **1-year score** (0–100) = business quality 30% + value at today's price 25% + Momentum score 25% + trend health 10% (price above the 200-day average, 50-day above 200-day) + risk 10% (balance-sheet risk category, minus a penalty for high daily volatility). Momentum gets real weight because a year is short enough for the market's current direction to matter.

| Signal | Rule |
|---|---|
| **1-yr buy** | score ≥ 75, quality ≥ 60, Momentum ≥ 50, price above its 200-day average, not "too hot", no red flags. Hold about 12 months, review quarterly; exit below the higher of the 200-day average or −15%; consider taking profit near the fair-value estimate |
| **1-yr watch** | score ≥ 65 |
| **Neutral** | score 45–64 |
| **Avoid** | score below 45 |
| **Risk review** | any long-term red flag |

Computed in the browser from the same data (`oneYear()` in `assets/app.js`); not backtested.

## My portfolio

Enter your holdings (ticker, shares, optional average cost, plus cash) in the **My portfolio** card. They're saved in your browser's local storage only, never uploaded, so they don't follow you to another device or browser.

With holdings entered, the long-term signals become personal:

| Signal | Rule |
|---|---|
| **Accumulate** | you own it, score ≥ 80, still attractively valued (valuation ≥ 60% of its points or ≥ 10% below fair value), and adding keeps you under the position and sector caps |
| **Hold** | you own it and nothing has broken |
| **Trim review** | you own it and it's over 5% of your portfolio, or the price is 60%+ above fair value |
| **Exit review** | you own it and it has a red flag or its score fell below 50 |
| **Buy review → Watchlist** | a buy candidate whose starter position would push its sector over 25% |

The card shows total value, gain on cost, drawdown of today's holdings from their 1-year high (alerts at −10/−15/−20%), position and sector cap breaches, and speculative exposure (unscored or score < 50) above 5%. **Portfolio Fit** (0–100, the *Fit* column) = room under the 5% position cap (40) + room under the 25% sector cap (35) + diversification, fewer holdings in the same sector (25). Limits are constants at the top of the portfolio section in `assets/app.js`.

## Stock detail view

Click any row for a full page on that stock: score, quality, value and fit; category breakdown and red flags; a year of weekly prices against the bear/base/bull fair-value range; six fiscal years of revenue, free cash flow, operating margin and ROIC (ROE for financials); weekly long-term score history (stored in `data/score_history.json`, two years deep); the plain-language thesis; and every metric with the points it earned. Links go to Yahoo Finance and the company's SEC filings.

**Not built yet:** analyst estimates, AI review of filings for moat and governance evidence, and backtesting.

## Short-term setups (switch Horizon)

Rows highlighted green match one of two well-known momentum patterns, checked against the latest close. Hover or tap **Why?** for a plain-English explanation, how long the rule suggests holding, and the price at which to get out.

| Signal | Rule | Suggested hold | Exit |
|---|---|---|---|
| **Breakout** | Price above its 50-day average, which is above its 200-day; within 3% of its 1-year high; RSI 55–75; 10-day volume ≥ 1.2× the 50-day average; 3-month return positive | about 4–8 weeks | close below the higher of the 50-day average or −8% |
| **Buy the dip** | Growth score ≥ 80; 50-day above 200-day and price above the 200-day; down 2–10% this week; RSI 35–50 | about 1–3 months | close below the higher of the 200-day average or −10% |
| **Too hot** (warning) | RSI ≥ 80 or up 60%+ in a month | don't chase | — |

Only stocks priced at least $5 that trade at least $5M a day qualify. These are mechanical screens, not predictions or financial advice. The rules live in `setupFor()` in `assets/app.js`.

## How it works

```
scripts/fetch_data.py  ──►  data/stocks.json  ──►  index.html + assets/app.js
 (Nasdaq listing + Yahoo prices)   (one JSON file)     (static page, no build step)
```

Three scripts run in GitHub Actions: `fetch_data.py` (prices, daily), `fetch_fundamentals.py` (SEC financial statements, Saturdays) and `score.py` (long-term scores, after every run).

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
