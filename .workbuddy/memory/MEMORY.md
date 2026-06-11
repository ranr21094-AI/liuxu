# Project Memory

## WeStock CLI Integration
- CLI package: `westock-data-clawhub@1.0.4` (via `npx -y`)
- `quote` command does NOT exist in the CLI — use `kline` or `minute` for quote/price data instead
- Available tools: search, kline, minute, finance, profile, asfund, hkfund, usfund, lhb, blocktrade, margintrade, buyback, technical, chip, shareholder, dividend, etf, etf-holdings, etf-nav, etf-company, etf-holders, etf-financial, hot, board, calendar, ipo, exdiv, reserve, suspension
- Windows: `spawn` must use `shell: true` because `npx` is a `.cmd` script, not a native executable
