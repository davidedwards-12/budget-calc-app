# Budget Statement Analyzer

A lightweight browser app for importing bank-statement CSV files and turning them into a quick money summary.

## What it does

- Upload or paste a bank statement CSV.
- Detect common columns like `Date`, `Description` or `Merchant`, and `Amount` or `Debit`/`Credit`.
- Estimate:
  - total income
  - total spending
  - transfers to savings
  - net cash flow for the statement period
  - spending by category
  - top merchants
- Show a transaction table with inferred categories.

## Supported CSV shapes

The app is designed for common bank exports such as:

```csv
Date,Description,Amount
2026-03-01,Payroll Deposit,2450.00
2026-03-02,Trader Joe's,-84.12
```

or:

```csv
Date,Merchant,Debit,Credit
2026-03-01,Payroll Deposit,,2450.00
2026-03-02,Trader Joe's,84.12,
```

## How to run it

Because the app is fully static, you can open `index.html` directly in a browser.

If you want to serve it locally instead:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Files

- `index.html`: app structure
- `styles.css`: visual design and responsive layout
- `app.js`: CSV parsing, transaction cleanup, category inference, and summary calculations

## Notes

- Categories are inferred using simple keyword matching, so you can expand the rules in `app.js` as you see real statement data.
- Savings is currently estimated from transactions that look like transfers to savings accounts.
- Net cash flow is calculated as `income - spending - savings transfers`.
