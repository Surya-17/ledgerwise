# Ledgerwise

A personal finance app built on a **double-entry ledger**, designed with the same correctness guarantees used by payment and banking systems: exact integer money, balanced journal entries enforced by the database, idempotent writes, an append-only audit trail, and safe re-import of bank statements.

**Stack:** Python 3.13 · FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL · pytest + Hypothesis · React 19 + TypeScript · TanStack Query · Tailwind · Recharts · Docker · GitHub Actions

**Live demo:** _add your Render URL here_ — click **Try the live demo** for a private sandbox with six months of data, no sign-up.

![Dashboard](docs/dashboard.png)

---

## Why double-entry?

Most budgeting apps store a list of transactions with a signed amount. That works until money moves *between* your own accounts, a refund arrives, or you need to prove a balance is correct.

Here, every financial event is a **journal entry** made of **lines** against accounts. Debits are positive, credits are negative, and **every entry must sum to zero in each currency**:

| Event | Line | Account | Amount |
|---|---|---|---|
| Groceries on a credit card | debit | Expenses:Groceries | +84.20 |
| | credit | Liabilities:Visa | −84.20 |
| Paying the card from checking | debit | Liabilities:Visa | +500.00 |
| | credit | Assets:Checking | −500.00 |

Because every entry balances, the whole ledger always satisfies the accounting equation **Assets + Expenses = Liabilities + Equity + Income**. That gives us a single, checkable definition of "correct", which the test suite verifies against randomly generated ledgers.

## Correctness guarantees

| Guarantee | How it's enforced |
|---|---|
| **No floating-point money** | Amounts are `BIGINT` minor units (cents) plus an ISO 4217 currency. Input strings are parsed with `Decimal`, and excess precision (`12.345 USD`) is **rejected, never rounded**. |
| **Entries always balance** | Validated in the service layer, *and* by a PostgreSQL `DEFERRABLE INITIALLY DEFERRED` constraint trigger that re-checks every entry at commit, even for SQL that bypasses the app. |
| **History is immutable** | Triggers block `UPDATE`/`DELETE` on journal entries, journal lines and the audit log. Mistakes are corrected with **reversing entries**; recategorizing = reverse + repost. |
| **An entry can be reversed only once** | `UNIQUE (reverses_id)`, so two concurrent reversal requests can't both win. |
| **Retries never double-post** | `Idempotency-Key` header on write endpoints. The stored response is committed in the *same transaction* as the work, and a primary key on `(user_id, key)` resolves races. Reusing a key with a different body returns 422. |
| **Transfers between your own accounts count once** | When an imported row mirrors an earlier *uncategorized* import from another of your accounts (opposite amount, ±3 days), the earlier entry is reversed and one transfer is posted instead, so a checking→savings move isn't recorded as both spending and income. Each earlier entry can be claimed once, and re-importing either statement stays a no-op. |
| **Re-importing a statement never double-counts** | Each CSV row gets a SHA-256 fingerprint `(account, date, amount, normalized description, occurrence #)`, with `UNIQUE (user_id, import_fingerprint)`. The occurrence counter keeps two identical $4.50 coffees on the same day distinct. |
| **Imports are atomic** | If any row fails to parse, nothing is saved and every bad row is reported with its line number. |
| **Tenant isolation in the schema** | Journal lines reference accounts through a composite FK `(account_id, user_id, currency)`, so the database itself rejects a line that points at another user's account or the wrong currency. |
| **Every change is audited** | Audit events are written in the same transaction as the change: an audit row exists if and only if the change committed. |

## The dashboard

| | |
|---|---|
| **Overview** | Net worth over time, income vs. spending, spending by category, budget progress, recent activity |
| **Transactions** | Search and filter; expand any row to see its debit/credit journal lines; reverse or recategorize (both post new entries, never edits) |
| **New transaction** | Expense / income / transfer, with a live journal preview of the lines that will post. Each form carries one `Idempotency-Key`, so a double-click or retry can't double-post |
| **Accounts** | Assets, liabilities and categories with computed balances; opening balances post against equity |
| **Budgets** | Month-by-month limits vs. actuals, status with icon + label (never colour alone), copy from last month |
| **Recurring** | Subscriptions, bills and paychecks detected from ledger history, with monthly cost, next expected date, and *lapsed* flags for charges that stopped |
| **Import** | CSV drag-and-drop with client-side preview, column mapping and date-format detection; shows new, duplicate and transfer-matched rows; categorization rules |
| **Export** | Accountant-style journal CSV (one row per line, debit/credit columns) for the current filters |
| **Audit log** | The append-only event trail, with raw JSON details per event |

Money input is parsed from strings into integer minor units in the browser too ([`money.ts`](frontend/src/lib/money.ts)), with the same reject-don't-round rule as the API. Light and dark themes, responsive down to phone width.

<p><img src="docs/transactions.png" width="49%" alt="Transaction journal lines"> <img src="docs/dashboard-dark.png" width="49%" alt="Dark mode"></p>

![Recurring charges](docs/recurring.png)

## Architecture

```
React (Vite, TS) ──HTTP/JSON──▶ FastAPI routers      ← validation, auth, idempotency
  served by FastAPI in prod        │                     (one origin, one service)
                                   │
                                   ▼
                              Service layer          ← ledger rules live here
                         ledger · imports · reports
                                   │
                                   ▼
                          SQLAlchemy 2 / Alembic
                                   │
                                   ▼
                     PostgreSQL  ← constraints + triggers as the last line of defense
```

```
backend/
  app/
    models.py            schema & ledger data model
    money.py             Decimal parsing, minor units, currency exponents
    services/ledger.py   post_entry, reverse_entry, recategorize_entry
    services/imports.py  CSV parsing, fingerprinting, rule-based categorization
    services/reports.py  balances, cash flow, net worth, spending, budget vs actual
    services/recurring.py  cadence detection for subscriptions, bills, paychecks
    services/demo.py     realistic six-month demo ledger (seed script + demo sandboxes)
    services/idempotency.py
    routers/             thin HTTP layer
  alembic/versions/      0001 schema, 0002 PostgreSQL integrity triggers
  tests/                 API tests, property-based tests, PostgreSQL trigger tests
  scripts/seed.py        CLI wrapper around services/demo.py
frontend/
  src/lib/               API client, exact money parsing, entry → transaction view
  src/pages/             Overview, Transactions, Accounts, Budgets, Import, Audit log
  src/components/        UI kit, charts, new-transaction modal
Dockerfile               multi-stage: build the SPA, then a slim Python runtime
render.yaml              Render Blueprint (web service + PostgreSQL)
```

## API overview

Interactive docs at `http://localhost:8000/docs` once running.

| Method | Path | |
|---|---|---|
| `POST` | `/api/auth/register`, `/api/auth/token` | Register; OAuth2 password login → JWT |
| `POST` | `/api/auth/demo` | Create a private, seeded sandbox and return its token (rate-limited per IP) |
| `GET` `POST` `PATCH` | `/api/accounts` | Accounts with live balances; optional opening balance |
| `GET` `POST` | `/api/entries` | List/filter/search; post a balanced entry (idempotent) |
| `GET` | `/api/entries/export` | Journal CSV (same filters), with spreadsheet formula injection neutralized |
| `POST` | `/api/entries/{id}/reverse` | Reverse an entry |
| `POST` | `/api/entries/{id}/recategorize` | Move an entry to another category (reverse + repost) |
| `POST` `GET` | `/api/imports` | Upload a CSV statement (custom columns, date format, sign) |
| `GET` `POST` `DELETE` | `/api/rules` | Auto-categorization rules |
| `GET` `PUT` `DELETE` | `/api/budgets` | Monthly budgets and budget-vs-actual |
| `GET` | `/api/reports/cash-flow`, `/api/reports/net-worth`, `/api/reports/spending` | Monthly reports; spending by category |
| `GET` | `/api/reports/recurring` | Detected recurring series |
| `GET` | `/api/audit` | Audit trail |

## Running locally (Windows)

Prerequisites: Python 3.12+, PostgreSQL 16+.

```powershell
# 1. Create the database (psql ships with PostgreSQL)
psql -U postgres -c "CREATE DATABASE ledgerwise;"

# 2. Install and configure the backend
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
copy .env.example .env        # then edit DATABASE_URL and JWT_SECRET

# 3. Create the schema, load demo data, run the API
alembic upgrade head
python -m scripts.seed        # demo@ledgerwise.dev / demo-password
fastapi dev app/main.py       # http://localhost:8000/docs

# 4. In a second terminal, run the frontend (proxies /api to :8000)
cd frontend
npm install
npm run dev                   # http://localhost:5173
```

## Deploying

The app ships as **one Docker image**: Node builds the React app, then FastAPI serves it alongside the API, so there's one origin (no CORS) and one service to run. Migrations run on boot.

**Render (free tier, ~5 minutes):**

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. [`render.yaml`](render.yaml) creates the web service and a PostgreSQL database, wires `DATABASE_URL`, and generates `JWT_SECRET`.
3. Open the service URL and click **Try the live demo**.

Free-tier notes: the web service sleeps after 15 minutes idle (the first request takes ~30–60 s to wake), and Render's free PostgreSQL expires after 30 days. For a permanent free database, create one on [Neon](https://neon.tech) and set `DATABASE_URL` on the service to its connection string instead. `postgres://` URLs are normalized to the psycopg 3 driver automatically.

Any Docker host works the same way: set `DATABASE_URL` and `JWT_SECRET`, expose `$PORT`.

## Testing

```powershell
cd backend
pytest                        # fast: in-memory SQLite, no setup
$env:TEST_DATABASE_URL = "postgresql+psycopg://postgres:PASSWORD@localhost:5432/ledgerwise_test"
pytest                        # full: real PostgreSQL, including trigger tests
```

The suite includes:

- **Property-based tests (Hypothesis):** for hundreds of randomly generated ledgers, the accounting equation holds; any unbalanced entry is rejected and leaves no trace; reversing every entry returns every balance to exactly zero.
- **Money tests:** format → parse round-trips for every supported currency, and rejection of sub-cent precision, scientific notation and `NaN`.
- **API tests:** auth, cross-user isolation, idempotent replay and key-reuse conflicts, reversal rules, imports (re-import, overlapping statements, duplicate identical rows, atomic failure, custom formats) and reports.
- **Transfer matching and recurring detection:** both sides of a transfer collapse to one entry, re-imports stay idempotent, out-of-window and categorized rows are left alone; cadences (weekly → yearly, including 1st-and-15th paychecks), lapsed subscriptions, and reversals not counting as occurrences.
- **Frontend unit tests (Vitest):** exact string-to-minor-unit parsing and its round trip with formatting, and the ledger-to-transaction view (transfers vs. spending, card payments, splits).
- **Database guard tests:** the triggers and composite foreign keys reject unbalanced, mutated or cross-tenant rows written with raw SQL.

CI runs lint, `alembic upgrade head`, `alembic check` (migrations match the models) and the full suite against PostgreSQL 17 on every push.

## Design decisions & trade-offs

- **Balances are computed, not stored.** Every balance is `SUM(amount_minor)` over journal lines, so there's no cached number to drift out of sync. At personal-finance scale this is fast with the `(account_id)` and `(user_id, occurred_on)` indexes. At larger scale I'd add periodic balance snapshots (checkpoints) and sum only the lines after the latest one.
- **Reversals default to the original date** so historical monthly reports net out correctly. Real accounting systems often post corrections in the current open period instead; that would be a configurable policy.
- **Multi-currency is per-currency balancing, without FX.** Each entry must balance within each currency. A cross-currency transfer would need an FX "trading" account, which is the standard extension and fits this model unchanged.
- **Idempotency records are kept indefinitely.** A production system would expire them after ~24 hours with a scheduled cleanup.
- **One sandbox per demo visitor.** The ledger is append-only, so a shared demo login would let every visitor rewrite everyone's history (and the database triggers would stop anyone from cleaning it up). `POST /api/auth/demo` instead creates a fresh user seeded through the same service layer, rate-limited per IP with a sliding window. The limiter is in-memory, which is correct for one instance; several instances would need Redis. It reads the *last* `X-Forwarded-For` hop, the one the trusted proxy appended, because earlier hops are client-controlled. Demo users are never deleted (the triggers forbid it); a production system would partition them or use `TRUNCATE`-based expiry.
- **Transfer matching is conservative.** It only merges when the earlier side is still uncategorized and no rule matched the new row, so a $500 rent payment and a coincidental $500 deposit are never merged. The cost is that a transfer whose first side was manually categorized stays as two entries, which the user can fix by recategorizing. Merging happens at import time (not as a background job) so it's atomic with the import and visible in the result.
- **Recurring detection is heuristic, not ML.** Group by a normalized merchant key, then require ≥3 occurrences whose gaps fit one cadence (≥75% within tolerance of the median). It's fully explainable, which matters when the output drives "you have a subscription you forgot" prompts. Monthly estimates use exact rational arithmetic (`Fraction`) and round once.

## Roadmap

- [x] Ledger core, idempotency, audit log, CSV import, reports, budgets
- [x] React + TypeScript dashboard
- [ ] Plaid sandbox integration (bank linking, webhook-driven sync)
- [x] Recurring-transaction detection
- [x] Transfer matching across imported accounts
- [x] Journal CSV export
- [x] One-image deploy (Docker + Render Blueprint) with per-visitor demo sandboxes
