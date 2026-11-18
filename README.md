# Ledgerwise

A personal finance app built on a **double-entry ledger**, designed with the same correctness guarantees used by payment and banking systems: exact integer money, balanced journal entries enforced by the database, idempotent writes, an append-only audit trail, and safe re-import of bank statements.

**Stack:** Python 3.13 · FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL · pytest + Hypothesis · React 19 + TypeScript · TanStack Query · Tailwind · Recharts · Docker · GitHub Actions

**Live demo:** **[ledgerwise-r6pa.onrender.com](https://ledgerwise-r6pa.onrender.com)**: click **Try the live demo** for a private sandbox with six months of data, no sign-up. (Free hosting sleeps when idle, so the first load can take ~30–60 s.)

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
| **System accounts can't be forked** | Opening Balance Equity and the Uncategorized fallbacks are found by name by the importer, so they can't be renamed, archived, or impersonated by a new account with a reserved name. |
| **Split bills never lose a cent** | Splits use the largest-remainder method on integer minor units ($100 three ways is 33.34 / 33.33 / 33.33), so shares always sum to the bill exactly. Itemized receipts split each item among whoever had it, then spread tax and tip by subtotal with the same method. Hypothesis property tests check both for arbitrary inputs, and the frontend preview mirrors the server's algorithm. |
| **Every change is audited** | Audit events are written in the same transaction as the change: an audit row exists if and only if the change committed. |

## The dashboard

| | |
|---|---|
| **Overview** | Net worth over time, income vs. spending, spending by category, budget progress, recent activity |
| **Transactions** | Search and filter; expand any row to see its debit/credit journal lines; reverse or recategorize (both post new entries, never edits) |
| **New transaction** | Expense / income / transfer, optionally **split across categories**, with a live journal preview of the lines that will post. Each form carries one `Idempotency-Key`, so a double-click or retry can't double-post |
| **Accounts** | Assets, liabilities and categories with computed balances; opening balances post against equity |
| **Budgets** | Month-by-month limits vs. actuals, status with icon + label (never colour alone), copy from last month |
| **Shared** | Splitwise-style bill splitting with friends and groups. Six ways to split: equally, exact amounts, percentages, shares, equal-with-adjustments, and itemized receipts with tax and tip. You or a friend can pay. Notes, editing (reverse + repost), weekly/monthly repeating bills, per-friend and per-group balances, group totals (who paid, your share by category), settle up, copy-a-reminder, CSV export, and "describe the bill" to fill the form. Each bill is one balanced journal entry (see below) |
| **Recurring** | Subscriptions, bills and paychecks detected from ledger history, with monthly cost, next expected date, and *lapsed* flags for charges that stopped |
| **Import** | CSV drag-and-drop with client-side preview, column mapping and date-format detection; shows new, duplicate and transfer-matched rows; categorization rules |
| **Export** | Accountant-style journal CSV (one row per line, debit/credit columns) for the current filters |
| **Audit log** | The append-only event trail, with raw JSON details per event |

Money input is parsed from strings into integer minor units in the browser too ([`money.ts`](frontend/src/lib/money.ts)), with the same reject-don't-round rule as the API. Light and dark themes, responsive down to phone width.

<p><img src="docs/transactions.png" width="49%" alt="Transaction journal lines"> <img src="docs/dashboard-dark.png" width="49%" alt="Dark mode"></p>

![Recurring charges](docs/recurring.png)

## Operational hardening

- **Brute-force protection:** failed sign-ins are limited per account (10 per 15 min, from any address) and per address (30 per 15 min, across accounts), with `Retry-After`. Only failures count, and a successful sign-in clears the account's counter. Demo sandbox creation is limited per address too. The limiter is an in-process sliding window behind a small interface ([`ratelimit.py`](backend/app/ratelimit.py)), so moving to Redis for multiple instances doesn't touch callers.
- **Security headers** on every response: a strict Content-Security-Policy (same-origin plus Google Fonts), `X-Frame-Options: DENY`, `nosniff`, a referrer policy, and HSTS over HTTPS.
- **Request IDs:** every response carries `X-Request-ID` (a sane upstream ID is propagated), and API calls are access-logged with method, path, status, latency and that ID.
- **Readiness-aware health check:** `/api/health` runs `SELECT 1`, returning 503 when the database is down so the platform stops routing traffic. Postgres connections time out after 5 s instead of hanging.
- **CI boots the real image:** besides the backend (PostgreSQL) and frontend jobs, CI builds the production Docker image, starts it against PostgreSQL 17, and smoke-tests the SPA, a deep link, the headers, and a demo sign-in through to real API data.

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
| `GET` `POST` | `/api/friends` | Friends with running balances (+ they owe you, − you owe them) |
| `GET` `POST` `PATCH` `DELETE` | `/api/groups` | Friend groups with per-group balances and total spend |
| `GET` | `/api/groups/{id}/summary` | Group totals: spent, your share, who paid, your share by category, by month |
| `GET` | `/api/shared` | Split bills and settle-ups, filterable by group or friend |
| `POST` | `/api/shared/expenses` | Split a bill (equal / exact / percent / shares / adjust / itemized), optionally repeating weekly or monthly; idempotent |
| `PUT` | `/api/shared/expenses/{id}` | Edit a bill: reverses the old entry and posts the new one atomically; idempotent |
| `GET` `POST` | `/api/shared/recurring`, `/api/shared/recurring/run`, `/api/shared/recurring/{id}/stop` | Repeating bills: list, post what's due (safe to repeat), stop |
| `POST` | `/api/shared/parse` | Turn "Dinner $90 with Alex and Sam, I paid" into a draft for the split form (nothing is saved) |
| `POST` | `/api/shared/settlements` | Record a friend paying you back, or you paying them; idempotent |
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

**Optional AI for "describe the bill":** set `AI_API_KEY` to a free [Google AI Studio](https://aistudio.google.com/apikey) key (Render: service → Environment). Without it, the built-in rule-based parser is used. `AI_MODEL` defaults to `gemini-flash-latest`. On Gemini's free tier, Google may use prompts to improve its products, so the note and your friend, group, category and account *names* (never balances or ids) leave the app when a key is set.

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
- **Frontend unit tests (Vitest):** exact string-to-minor-unit parsing and its round trip with formatting, the ledger-to-transaction view (transfers vs. spending, card payments, splits), and the journal-line builder (including a randomized check that every generated entry balances).
- **Security tests:** headers, request-ID propagation, per-account and per-address sign-in limits, and counter reset on success.
- **Database guard tests:** the triggers and composite foreign keys reject unbalanced, mutated or cross-tenant rows written with raw SQL.

CI runs lint, `alembic upgrade head`, `alembic check` (migrations match the models) and the full suite against PostgreSQL 17 on every push.

## Design decisions & trade-offs

- **Balances are computed, not stored.** Every balance is `SUM(amount_minor)` over journal lines, so there's no cached number to drift out of sync. At personal-finance scale this is fast with the `(account_id)` and `(user_id, occurred_on)` indexes. At larger scale I'd add periodic balance snapshots (checkpoints) and sum only the lines after the latest one.
- **Reversals default to the original date** so historical monthly reports net out correctly. Real accounting systems often post corrections in the current open period instead; that would be a configurable policy.
- **Multi-currency is per-currency balancing, without FX.** Each entry must balance within each currency. A cross-currency transfer would need an FX "trading" account, which is the standard extension and fits this model unchanged.
- **Idempotency records are kept indefinitely.** A production system would expire them after ~24 hours with a scheduled cleanup.
- **One sandbox per demo visitor.** The ledger is append-only, so a shared demo login would let every visitor rewrite everyone's history (and the database triggers would stop anyone from cleaning it up). `POST /api/auth/demo` instead creates a fresh user seeded through the same service layer, rate-limited per IP with a sliding window. The limiter is in-memory, which is correct for one instance; several instances would need Redis. It reads the *last* `X-Forwarded-For` hop, the one the trusted proxy appended, because earlier hops are client-controlled. Demo users are never deleted (the triggers forbid it); a production system would partition them or use `TRUNCATE`-based expiry.
- **Transfer matching is conservative.** It only merges when the earlier side is still uncategorized and no rule matched the new row, so a $500 rent payment and a coincidental $500 deposit are never merged. The cost is that a transfer whose first side was manually categorized stays as two entries, which the user can fix by recategorizing. Merging happens at import time (not as a background job) so it's atomic with the import and visible in the result.
- **Shared bills are tracked from your side only.** Friends are private contacts, not users, so a bill Alex paid only records *your* share; what Sam owes Alex isn't your ledger's business. That keeps every entry about your money. Real multi-user groups (everyone logs in and sees one shared tab) would need a separate shared ledger per group, with each member's personal ledger subscribing to it. The model here would carry over unchanged.
- **Recurring detection is heuristic, not ML.** Group by a normalized merchant key, then require ≥3 occurrences whose gaps fit one cadence (≥75% within tolerance of the median). It's fully explainable, which matters when the output drives "you have a subscription you forgot" prompts. Monthly estimates use exact rational arithmetic (`Fraction`) and round once.

## Shared bills in a double-entry ledger

Each friend is an asset account whose balance is what they owe you; a negative balance is what you owe them. A split bill is then an ordinary balanced entry, so friend balances, net worth, budgets and reports all stay exact:

| You paid $90 dinner on your card, split 3 ways | | Alex paid $90, split 3 ways | |
|---|---|---|---|
| Dining (your share) | +30 | Dining (your share) | +30 |
| Alex | +30 | Alex (you owe him) | −30 |
| Sam | +30 | | |
| Visa Card | −90 | | |

Only your share ever becomes spending, so budgets stay honest. Settling up is a transfer between a bank account and the friend's account. Removing a bill posts a reversing entry, like everywhere else. The split's details (payer, method, group, notes, what was typed) live in a separate `shared_entries` row; the money lives only in journal lines.

- **Editing never rewrites history.** `PUT /shared/expenses/{id}` reverses the old entry and posts the corrected one in the same transaction, linked by `edited_from_id`. The bill keeps the inputs as typed (shares, percentages, items), so it reopens exactly as entered rather than as derived cents.
- **Repeating bills are posted on demand, exactly once.** There's no cron on a free host that sleeps. Instead, opening Shared calls `POST /shared/recurring/run`, which posts every occurrence that's due (catching up missed months). Each occurrence is a normal bill with `(recurring_id, occurrence_on)` unique, so two tabs racing lose at the constraint instead of double-posting. Monthly bills keep their day: the 31st becomes Feb 28, then Mar 31. A bill that can no longer post (say, a friend was removed) stops and leaves an audit record instead of guessing.
- **Itemized receipts are exact.** Each item is split equally among the people who had it. Tax, tip and fees (or a discount) are then spread in proportion to each person's subtotal, using largest-remainder on cents, so the shares always sum to the receipt.

### Describe a bill, get a filled form

The split form takes a sentence like *"Cabin 600 on Tahoe ski trip except Jordan, Alex paid"* or *"Groceries 69: Priya 23, Sam 23, me 23, paid with my card yesterday"* and fills in the description, total, date, payer, card, category, group, people and split. The design keeps the model away from the money:

- **Two extractors, one contract.** An LLM (Gemini's free tier, JSON-schema-constrained output) or a deterministic rule-based parser produces the same `RawBill` of *names and decimal strings*. The rules run when no key is set, when the model times out or is rate-limited, and in every test, so the feature never depends on a network call.
- **The server resolves, the model doesn't.** Names are matched only against the user's own friends, groups, categories and accounts (exact, then unique prefix, then close spelling); invented people are reported, not created. Amounts become integer minor units through the same `Decimal` parser as everything else, and "Alex 20, Sam 15, rest is mine" gets its remainder computed exactly.
- **It only fills a form.** Nothing is posted: the user sees the draft, with the remaining-to-assign bar and notes such as "Not found in your friends: Ravi", and saves through the normal validated, idempotent endpoint.
- **Bounded cost.** With a key set, each user gets 30 parses per 10 minutes, so one person can't use up the free quota.

## Roadmap

- [x] Ledger core, idempotency, audit log, CSV import, reports, budgets
- [x] React + TypeScript dashboard
- [ ] Plaid sandbox integration (bank linking, webhook-driven sync)
- [x] Recurring-transaction detection
- [x] Transfer matching across imported accounts
- [x] Journal CSV export
- [x] Splitwise-style shared bills: friends, groups, six split methods incl. itemized receipts, edits, repeating bills, group totals, settle up, reminders, CSV export
- [x] One-image deploy (Docker + Render Blueprint) with per-visitor demo sandboxes
