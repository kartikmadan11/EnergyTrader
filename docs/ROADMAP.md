# Roadmap

This document plans the next stage of EnergyTrader: a Rust trading core, roles with four-eyes approval, and a blotter that updates live.
The landing page, sign-in and a first blotter are delivered, and sections 4 and 5 record what was built and what remains.
It also records known modeling issues that the new work should fix rather than carry forward.
Each section states the decision, the reason for it, and how we will know it worked.

## 1. Context

### Current state

The backend is a single FastAPI process on Python 3.13 that owns everything: scrapers, feature engineering, per-segment gradient-boosted models, the bid LP, DSM policy, pre-trade checks, risk, audit and a nightly APScheduler pipeline.
Storage is one SQLite file whose schema comes from `Base.metadata.create_all`, with no migrations.
The web app signs people in with Auth.js through Sign in with Vercel or GitHub and admits only the accounts that `AUTH_ALLOWED_USERS` lists (`docs/AUTH.md`).
Its proxy attaches a 60-second signed token naming the user to every API call, and the API rejects calls without one (`backend/common/auth.py`).
Audit entries name the signed-in user, while rows written before sign-in existed show `trader`.
Every signed-in user has the same permissions, because there are no roles yet.
Submitting a bid set writes rows to the `bids` table with status `submitted` and an audit entry; nothing is sent to an exchange.
The blotter lists every submitted session and derives how much of it cleared from published prices.
Model training runs inside the API process, so a long retrain competes with interactive requests.

A walk-forward backtest over 1 to 28 October 2026 gives a MAPE of 13.8% for DAM, 28.4% for RTM and 14.6% for TAM, with R² of 0.88, 0.70 and 0.05.
Eleven of those 28 days fall inside the training window, so these figures are optimistic and only the held-out days should be quoted.

### Goals

1. Make the bid lifecycle correct by construction: typed units, decimal money, an explicit state machine, and an append-only record of who did what.
2. Extend the blotter from bid sessions to every order, with its status, outcome and cost, updated live.
3. Add roles and four-eyes approval on top of sign-in, so what a person can do depends on their role and nobody approves their own bids.
4. Fix the buy-side modeling issues in section 2 before anyone relies on the recommendations.

### Non-goals

- Order routing to an exchange and settlement with it; see phase 5.
- Rewriting forecasting in Rust, since Python's ML ecosystem is the right tool for it.
- Multi-tenancy, self-service signup or billing.
- Horizontal scale; at 96 blocks a day there are about 35 thousand price rows per segment per year, so one instance per service is enough.

## 2. Known modeling issues

### 2.1 The LP objective rewards expensive volume

`backend/bid_engine_service/optimizer.py` minimizes `Σ -bid_price[b]·v[b]` plus DSM and uncertainty terms, which means it maximizes bid price times volume.
For a buyer this is backwards: the solver prefers to place volume in the blocks where it expects to pay the most, up to `per_block_cap`, and only the DSM terms pull the schedule back toward load.
The total-volume constraint `Σ v[b] ≤ demand_mw × volume_scale` is an upper bound, so the objective also pushes total volume to that cap rather than to what the load needs.
Bid prices are fixed before the solve as forecast plus `price_offset × volatility`, so price is not a decision at all.
In a uniform-price auction a cleared buyer pays the clearing price, not its bid, so `bid_price × volume` is not even the cost of the schedule.

The replacement minimizes the expected cost of serving the load, where energy not bought in the day-ahead market has to come from somewhere else:

```text
Per block b, with block duration h = 0.25 hours:
  L[b]   load to serve, MW
  p[b]   expected DAM clearing price, INR/MWh
  r[b]   expected cost of energy not bought in DAM (RTM price or the DSM reference rate), INR/MWh
  σ[b]   DAM price uncertainty, INR/MWh
  ρ      share of over-procured energy recovered through settlement, 0 to 1

Variables, all ≥ 0, in MW:
  q[b]         volume bought in DAM
  u[b], o[b]   under- and over-procurement against L[b]
  e[b], s[b]   deviation beyond the band and beyond the severe threshold

minimize  Σ_b h · ( p[b]·q[b] + r[b]·u[b] - ρ·r[b]·o[b]
                    + λ1 · penalty_rate · r[b] · (e[b] + (multiplier - 1)·s[b])
                    + λ2 · σ[b] · q[b] )

subject to
  q[b] - L[b] = o[b] - u[b]
  e[b] ≥ u[b] + o[b] - deviation_band · L[b]
  s[b] ≥ u[b] + o[b] - severe_threshold · L[b]
  q[b] ≤ cap[b], and the technical minimum where it applies
```

The buyer's reservation price for a block is then the expected cost of the alternative, `r[b]` plus expected DSM charges, rather than the forecast plus an offset.
Solving the LP over a grid of DAM price levels gives the quantity the buyer should hold at each price, which is a monotone demand curve and exactly what a portfolio bid expresses (see 2.5).
Strategies then differ in risk appetite, not in a price offset.
Once quantile forecasts exist (2.3), the same model becomes a scenario LP, and a CVaR limit can replace the `λ2·σ` term while keeping the problem linear.

### 2.2 Demand is a daily total split evenly over blocks

The optimizer sets `load_per_block = demand_mw / NUM_BLOCKS`, and the workstation labels the input "Total Demand" with a default of 500 (`frontend/src/app/(app)/workstation/page.tsx`).
MW is a rate, so a 500 MW load needs 500 MW in every block, not 5.2 MW, and summing MW across blocks has no physical meaning.
The replacement is a per-block load schedule in MW, either from a load forecast produced by the forecast service or uploaded as 96 values.
The schedule is stored with the bid set, so validation, checks, risk and post-market review all measure deviation against the same baseline.

### 2.3 Forecast intervals are not calibrated

`PriceForecastModel.predict` in `backend/forecast_service/model.py` sets σ to the larger of half the block's 7-day price standard deviation and 8% of the prediction, and reports `prediction ± 1.96σ`.
Nothing checks that 95% of outcomes actually land inside that band.
The plan is to train quantile models (`HistGradientBoostingRegressor(loss="quantile")` at 0.05, 0.5 and 0.95) and calibrate them with split-conformal residuals from the walk-forward backtest, per segment and time-of-day bucket.
The Backtest page reports empirical coverage and mean interval width next to MAPE, and a retrained model is promoted only if held-out coverage is within 3 points of nominal.

Two related forecasting gaps belong in the same piece of work:

- Training uses observed weather from enriched rows, while prediction uses Open-Meteo forecasts or NaN when that call fails (`docs/FEATURES.md`).
  Training on archived as-of forecasts removes the skew; until then, the backtest should run with forecast weather so the number is honest.
- TAM has an R² of 0.05, and TAM contracts do not trade as a 96-block auction.
  Every model should be reported against a seasonal-naive baseline (same block, last week), and TAM recommendations should be withheld unless the model beats it.

### 2.4 DSM exposure uses price uncertainty as a volume proxy

`backend/risk_service/engine.py` assumes drawal deviates from schedule by the price forecast's relative half-width, clamped to 2 to 25%.
Price uncertainty and volume deviation are different quantities, so the expected DSM penalty is not tied to anything that causes deviation.
Deviation should come from the load forecast's error distribution, and uncleared volume from price scenarios evaluated against the bid curve.
Cost-at-risk assumes block errors are perfectly correlated, which is a safe upper bound; scenarios built from backtest residuals give both a realistic VaR and the CVaR used in 2.1.

### 2.5 Bids are single price-quantity points

Day-ahead and real-time markets on IEX accept portfolio bids as price-quantity pairs per block, as well as block bids across consecutive blocks, and clear by bid area with market splitting.
The platform submits one point per block, treats a bid as cleared when its price is at least the MCP, and ignores area prices.
The Rust domain models every order as a curve from day one, with a single point being a one-step curve, so curves need no schema change later.
Price history gains a bid-area column so that area clearing prices can be stored once they are scraped.

### 2.6 Policy edits overwrite history

`update_policy` in `backend/common/dsm_policy.py` rewrites the YAML file in place, and a bid set does not record the policy it was checked against.
After an edit, nobody can reproduce why a past bid set passed its checks.
Policies become immutable versions: an edit creates a new version, activation is an event, and every check result references the version it used.

## 3. Rust trading core

### 3.1 Why Rust

Speed is not the reason.
The LP has under 500 variables and HiGHS solves it in milliseconds from Python, and request latency is dominated by the database and model inference.
The reason is correctness in the part of the system that commits money:

- Unit newtypes make `MW + MWh` a compile error.
- Decimal money removes float rounding from prices, costs and penalties.
- An exhaustive `match` over lifecycle states means a new state cannot be forgotten in a handler.
- `sqlx` checks queries against the schema at compile time.
- One static binary with predictable memory is a good host for a long-lived WebSocket hub.

The cost is a second language, toolchain and deploy unit, which the strict service boundary below keeps contained.

### 3.2 Separate service rather than PyO3

The trading core runs as its own service, `et-api`, rather than as a PyO3 extension inside FastAPI.
With PyO3, the Python process would still own the request, the transaction and the session, and Rust would only be a library of pure functions, so the type guarantees would stop at the function boundary.
A separate service also isolates failures, so a memory-hungry retrain or a stuck scraper cannot stall order entry.
It releases independently, and it ships as a plain container instead of platform-specific maturin wheels.
PyO3 remains the right tool if a numeric kernel inside forecasting ever needs to be faster, which is not the case today.

### 3.3 Topology

```mermaid
flowchart LR
    browser[Browser] -->|HTTPS: pages and /api| web[Next.js<br/>Auth.js]
    web -->|/api with a signed token| core[et-api<br/>Rust, axum]
    browser -->|/ws with a one-time ticket| core
    core -->|unmigrated routes,<br/>on-demand forecasts| fc[Forecast service<br/>Python, FastAPI]
    worker[Forecast worker<br/>nightly pipeline] --> db[(PostgreSQL)]
    core --> db
    fc --> db
```

The browser talks to the web app for pages and `/api`, and the web app forwards `/api` to `BACKEND_URL` with the signed token it already sends the Python API today (5.2).
Pointing `BACKEND_URL` at `et-api` instead of the forecast service is the only change the web app needs.
`et-api` is then the only upstream for `/api`, so it acts as the strangler-fig facade.
It verifies the token on every request, serves the routes it owns, and forwards the rest to the forecast service with the actor in an internal header.
The forecast service listens only on the private network and accepts requests only with the internal service token.
Routing at the facade keeps the token check in one place, leaves the web app unchanged at each cutover, and guarantees that Python never sees an unauthenticated request.
The WebSocket is the one connection that skips the web app, because serverless hosting cannot hold a long-lived connection open; 5.10 covers how it is authenticated.

### 3.4 Crate layout

The Rust code lives in a Cargo workspace under `crates/`, next to `backend/` (the forecast service), `frontend/`, `migrations/` and `contracts/`.

| Crate | Responsibility | Depends on | External crates |
| --- | --- | --- | --- |
| `et-domain` | Units, segments, blocks, delivery calendar and gate closure, bid sets, orders, lifecycle state machine, commands and events | none | `rust_decimal`, `serde`, `time` |
| `et-policy` | Policy versions, DSM penalty math, bid validation | `et-domain` | none |
| `et-risk` | Cost-at-risk, DSM exposure, pre-trade checks and verdict | `et-domain`, `et-policy` | none |
| `et-optimizer` | LP formulations, strategy versions, rounding to tick and lot | `et-domain`, `et-policy` | `good_lp` with the HiGHS backend |
| `et-clearing` | Clearing simulator over recorded prices, curve evaluation, strategy backtests | `et-domain`, `et-policy` | none |
| `et-store` | Postgres access, event store, projections, forecast contract reads | `et-domain` | `sqlx` |
| `et-api` | HTTP and WebSocket API, token verification, roles and authorization, facade proxy, OpenAPI | all of the above | `axum`, `tokio`, `tower-http`, `reqwest`, `hmac`, `sha2`, `utoipa`, `tracing` |

Only `et-store` and `et-api` perform I/O, so the domain, policy, risk, optimizer and clearing crates are deterministic and property-testable.

### 3.5 Units, money and time

Quantities are newtypes over `rust_decimal::Decimal`: `Mw`, `Mwh`, `InrPerMwh` and `Inr`.
Only meaningful operations exist, such as `Mw × BlockDuration → Mwh` and `Mwh × InrPerMwh → Inr`.
Postgres stores them as `numeric` in exchange-native units, which means INR/MWh for prices, whereas the current schema stores INR/kWh (`PriceHistory.mcp`); the UI can keep displaying INR/kWh.
The solver works in `f64`, and its output is rounded to the segment's price tick and volume lot and then re-validated in `Decimal`, so validation, not the solver, is authoritative.
A `Block` is constructed only for values 1 to 96, and a delivery date plus block maps to a UTC interval.
IST is a fixed UTC+05:30 offset with no daylight saving, so no time zone database is needed; timestamps are stored as `timestamptz` in UTC and displayed in IST.

### 3.6 Bid lifecycle

The bid set is the unit that is checked, approved and submitted, and it moves through this state machine:

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Checked: checks pass or flag
    Checked --> Draft: edit
    Checked --> Approved: below four-eyes threshold
    Checked --> PendingApproval: above threshold or flagged
    PendingApproval --> Approved: approved by a second user
    PendingApproval --> Draft: sent back
    Approved --> Submitted: submit
    Approved --> Withdrawn: withdraw
    Approved --> Expired: gate closure
    Submitted --> Accepted
    Submitted --> Rejected
    Accepted --> Cleared
    Accepted --> PartiallyCleared
    Accepted --> Unmatched
    Cleared --> Settled
    PartiallyCleared --> Settled
```

`Draft`, `Checked` and `PendingApproval` can also be withdrawn or expire at gate closure; the diagram shows those exits only from `Approved` to stay readable.

A check result is bound to a content hash of the orders, the load schedule, the policy version and the forecast run.
Approval references that hash, so any edit returns the set to `Draft` and an approval can never be reused for different bids.
Gate closure comes from a market calendar per segment and session, and commands that arrive after it are rejected.
Transitions are implemented as `fn handle(state, command, actor) -> Result<Vec<Event>, DomainError>` with an exhaustive match, and state is the fold of the stream's events.
A typestate encoding was considered and rejected, because state is loaded from the database at runtime and the enum is simpler to read.
Each order carries its own clearing status, and the bid set's `Cleared`, `PartiallyCleared` or `Unmatched` state is the rollup over its orders.
Until exchange connectivity exists, `et-clearing` plays the exchange: it accepts submitted sets and clears them against published prices.

### 3.7 Event store

```sql
create table events (
    id             bigint generated always as identity primary key,
    stream_type    text        not null,  -- bid_set, policy, user
    stream_id      uuid        not null,
    version        integer     not null,
    event_type     text        not null,  -- e.g. BidSetSubmitted.v1
    payload        jsonb       not null,
    actor_kind     text        not null,  -- user or system
    actor_id       text        not null,
    correlation_id uuid        not null,
    occurred_at    timestamptz not null default now(),
    unique (stream_id, version)
);
```

The unique `(stream_id, version)` constraint gives optimistic concurrency, so a racing approve and withdraw cannot both succeed and the loser gets a `409`.
The application role has only `insert` and `select` on `events`, and a trigger rejects updates and deletes.
Projections such as `bid_sets`, `orders`, `blotter_rows` and the audit view are updated in the same transaction as the append, so reads never lag writes, and any projection can be rebuilt by replay.
After commit, `pg_notify` wakes the WebSocket hub.
Event types carry a version suffix, and old versions are upcast on read.
Only bid sets, policy versions and users are event-sourced; market data, forecasts and model runs stay as plain tables, because event-sourcing them adds cost without a use.
The existing `bids` and `audit_log` rows are imported once as `Imported.v1` events, and `audit_log` becomes a read model over `events`.

### 3.8 What moves and what stays

| Capability | Today | Target |
| --- | --- | --- |
| Policy storage, versions and penalty math | `common/dsm_policy.py` | `et-policy`, versions in Postgres |
| Bid validation | `bid_engine_service/optimizer.py` | `et-policy` |
| Pre-trade checks and verdict | `approval_service/checks.py` | `et-risk` |
| Cost-at-risk and DSM exposure | `risk_service/engine.py` | `et-risk` |
| Bid optimization | `bid_engine_service/optimizer.py` | `et-optimizer`, parity first, then 2.1 |
| Submission and lifecycle | `bid_engine_service/router.py` | `et-api` and `et-store` |
| Audit log and post-market review | `audit_service/router.py` | `et-api` and `et-clearing` |
| Sign-in and sessions | Auth.js in the web app | stays in the web app |
| API token verification | `common/auth.py` | `et-api` |
| Roles and authorization | none | `et-api` |
| Blotter | `blotter_service/` | `et-api` and `et-store` |
| WebSocket | none | `et-api` |
| Scrapers, enrichment, training, prediction, backtest | Python | stays in the forecast service |
| Nightly pipeline | APScheduler inside the API process | stays in Python, as a separate worker process |

Policies move from YAML files into Postgres as immutable versions, and the existing YAML files are imported once.
That also avoids a YAML dependency in Rust, where the main serde YAML crate is no longer maintained.

### 3.9 Contracts

The forecast service publishes runs to `forecast_runs` and `forecast_points`, with `p05`, `p50` and `p95` per block, a model version and a `published_at` timestamp.
`et-api` reads forecasts only through a `published_forecasts` view and never touches the forecast service's internal tables.
The view mirrors a versioned JSON Schema in `contracts/forecast.v1.json`, and both services run contract tests against it.
The database is the integration point rather than HTTP, so optimization and checks keep working on the last published forecast if the forecast service is down, and the forecast is read in the same transaction as the bid set.
On-demand forecasts go through `et-api` to the forecast service, which writes a run and returns its ID.

`et-api` serves OpenAPI 3.1 generated by `utoipa` from the handler types.
The frontend generates its TypeScript types with `openapi-typescript`, a development-only dependency, and CI fails if the committed types are stale.
This replaces the handwritten types in `frontend/src/lib/api.ts`, which can drift from the backend silently.

### 3.10 Migration

1. Record: a middleware in the forecast service writes request and response pairs for the routes being migrated to JSONL fixtures, captured against a seeded database snapshot.
2. Implement the route in Rust while the facade still forwards it to Python.
3. Shadow read-only routes: the facade calls both, returns Python's response, and logs any difference.
4. Prove parity in CI by replaying the fixtures against Rust.
   Verdicts and check statuses must match exactly, and money and prices must match to the tick.
   LP results are compared on objective value (relative tolerance 1e-6) and constraint satisfaction rather than exact volumes, because degenerate LPs have more than one optimum.
5. Cut over by flipping the route's entry in the facade's routing table, keeping the Python route for one release as a rollback.
6. Retire the Python router and its tests after one release without a rollback.

The order is read-only routes first (policy list, active and compare, audit log), then validation, risk and pre-trade checks, then submission, where the event store and four-eyes approval start.
After that comes the optimizer (`recommend`, `tune` and `compare-strategies`), then post-market review.

## 4. Blotter

### 4.1 Purpose

The blotter answers what was bid, who approved it, what cleared at what price, and what it cost, for today's sessions and for history.
Traders use it to watch live sessions, risk uses it to review approvals and exposure, and operations uses it for reconciliation.

### 4.2 Row model

In the target model a row is one order, which is one block of one bid set, and the UI groups rows by bid set.
The blotter delivered so far has one row per bid set, with its orders in the detail panel (4.3).

| Field | Meaning |
| --- | --- |
| `order_id`, `bid_set_id` | Order and bid set identifiers; `bid_set_id` is today's `session_id` |
| `market_session` | Auction the order belongs to, such as DAM for a delivery date or an RTM session |
| `segment`, `delivery_date`, `block` | Where and when the energy is delivered, with the IST window shown alongside |
| `side` | Buy today; sell is reserved |
| `price`, `curve_steps` | Top price in INR/MWh, and the number of curve steps |
| `quantity_mw`, `energy_mwh` | Bid quantity and the energy it represents |
| `strategy`, `overridden`, `override_reason` | How the order was produced and whether a person changed it |
| `verdict`, `policy_version` | Pre-trade verdict and the policy version it was checked against |
| `status` | Lifecycle state of the order |
| `submitted_by`, `approved_by` | Actors; approval is empty when it was automatic |
| `created_at`, `checked_at`, `approved_at`, `submitted_at`, `results_at` | Lifecycle timestamps in UTC |
| `cleared_mw`, `clearing_price` | Cleared quantity and clearing price (MCP, or area price once stored) |
| `forecast_p50`, `slippage` | Forecast at submission and clearing price minus forecast |
| `dsm_expected`, `dsm_uncleared` | Expected DSM exposure at check time and the realized exposure of uncleared volume, in INR |
| `cost`, `cost_vs_benchmark` | Cleared energy times clearing price, and the saving against the benchmark, in INR |

In a uniform-price auction a cleared buyer pays the clearing price, so bid price minus clearing price is headroom, not profit.
The blotter therefore reports cost against a benchmark, by default buying the same energy at the RTM price for the same block, which is the buyer's realistic alternative.
The benchmark is configurable, and a positive value means day-ahead procurement saved money.

### 4.3 Where rows come from

Phase 2 is delivered without a database view.
`blotter_service/queries.py` aggregates `bids` per session in SQL, joined to cleared prices from `price_history` and the submit entries in `audit_log`, so filters, sorting and totals run over the whole book rather than a loaded page.
A block clears when its bid price is at least the MCP.
A session is pending until any of its blocks is priced, and is then cleared, partial or not cleared by what has cleared so far.
A unique index on `bids (session_id, block)` keeps a session from being submitted twice.
Sessions submitted before sign-in existed show the actor as `trader`, and there is no `approved_by` until four-eyes approval exists.

Still planned for the per-order model are the forecast at submission, slippage, the DSM fields, and cost against a benchmark.
They need the forecast run and risk snapshot a bid set was checked against to be stored with it, which the event store provides.
In phase 3, `et-store` maintains `blotter_rows` as a projection inside the append transaction, with the same API shape, so the UI does not change.

### 4.4 API

Delivered:

- `GET /api/blotter` filters by delivery date range, segment, strategy, status, submitting user and session id prefix, and sorts by submission time, delivery date, volume, value or fill.
  It returns `{ rows, next_cursor, totals }` with keyset pagination on the sort key plus a per-session sequence, encoded as an opaque cursor, and a limit of at most 500.
  Totals cover every matching session, not only the returned page.
  Offsets are not supported, because they skip or repeat rows while new sessions arrive.
- `GET /api/blotter/{session_id}` returns the session with its block bids against the clearing price and its audit trail.
- `GET /api/blotter/export` takes the same filters and returns up to 10,000 sessions as CSV, with units in the column names and submission times in UTC ISO 8601.

Planned:

- The list response gains `as_of_event_id`, and rows and their cursor move from sessions to orders.
- The detail endpoint adds the check results a bid set was approved on and the forecast context for each block.
- The export streams the whole result instead of stopping at a cap, with timestamps in both UTC and IST.
- `WS /ws/blotter` starts with the client sending `{ "type": "subscribe", "filters": ..., "since": <as_of_event_id> }`.
  The server replays any matching events after `since` from the event table, then streams `upsert` messages tagged with `event_id`, plus a heartbeat every 15 seconds.
  The client drops messages it has already applied, so a REST snapshot followed by a subscription never misses or double-counts an update.
  A client that falls behind its bounded buffer receives `resync` and refetches over REST, so one slow browser cannot hold memory on the server.

### 4.5 UI

Delivered at `/blotter`:

- The table uses the full content width with tabular numerals and right-aligned numbers, and loads 50 sessions at a time up to 500.
- Filters live in the URL query string, and so does the open session (`?session=`), so a filtered view or a single session can be shared or bookmarked.
- The page polls every 15 seconds while live, can be paused, and highlights sessions that arrive since the last refresh.
- Selecting a row opens a side panel with the session's facts, its bids against the clearing price block by block, and its audit trail with actor and IST time.
- CSV export downloads the current filter, not just the loaded page.
- `Enter` opens the focused row, `j` and `k` step through sessions while the panel is open, and `Esc` closes it.

Planned, with rows moving to orders at the same URL:

- A sticky header and identifier column, and 28-pixel rows.
- Rendering uses TanStack Table and TanStack Virtual; both are headless and small, and hand-rolling virtualization with grouping and sticky columns would be substantially worse.
- A column chooser controls visibility and order, saved per user on the server so it follows them between machines.
- Grouping by bid set shows an aggregate row with block range, energy, volume-weighted clearing price and a status rollup, and it expands to the orders.
- Live updates over the WebSocket replace polling and flash the changed cells briefly without shifting layout.
  While the user is scrolled away from the top or has a row focused, new rows are held behind an "N new updates" pill instead of reordering under the cursor.
- The side panel adds the check results at approval, a forecast versus bid versus clearing chart for each block, and the risk snapshot.
- Arrow keys and `j` and `k` move between rows in the table itself, `/` focuses search, and `?` lists shortcuts.
- The table uses `role="grid"` with `aria-rowcount` and `aria-rowindex`, so screen readers handle the virtualized rows.
- The status bar shows the WebSocket state and the time of the last update, and a stale-data banner appears if the connection drops.

### 4.6 Performance targets

Three segments, 96 blocks and a few bid sets per day come to about 300 thousand orders per year, which sets the scale for these targets.

| Measure | Target |
| --- | --- |
| `GET /api/blotter` first page of 200 rows over 300 thousand orders | p95 under 100 ms at the server |
| Event commit to updated cell in the browser | p95 under 250 ms on the office network |
| Scrolling 10 thousand loaded rows | 60 frames per second on a mid-range laptop |
| WebSocket clients per `et-api` instance | 500, with resident memory under 200 MB |
| CSV export of 300 thousand orders | first byte in under 1 second |

## 5. Landing page and authenticated access

Routes, the proxy, accounts, sessions and named audit actors (5.1 to 5.4 and 5.9) are delivered, and [AUTH.md](AUTH.md) covers their setup and deployment.
CSRF hardening, rate limits, roles, four-eyes approval and the authenticated WebSocket are planned.

### 5.1 Routes

The public landing page is `/`, sign-in is `/login`, and every app page lives in an `(app)` route group at URLs such as `/workstation` and `/blotter`.
`frontend/src/proxy.ts` denies by default: only `/` and `/login` are public, so a new page is protected without anyone adding it to a list.
That gives the safety the planned `/app` prefix was meant to give, without moving every URL, and a list of two public pages is small enough to review at a glance.
The `(app)` layout checks the session again, so a page is never served on the strength of the proxy alone.
`/bids` still redirects permanently to `/workstation`.

The landing page states what the product does, walks through the workflow from forecast to review, states that it does not connect to an exchange, and offers sign-in.
It loads no third-party scripts or trackers, and it quotes no accuracy figures.

### 5.2 Proxy

The proxy validates the Auth.js session on every page and `/api` request, rather than only checking that a cookie is present.
A page request without a session redirects to `/login?callbackUrl=<path>`, and an `/api` request gets a `401` that the API client turns into the same redirect.
`callbackUrl` is honored only when it is a same-origin path other than `/login`; absolute, protocol-relative and backslash forms fall back to the workstation, which prevents open redirects.
For `/api`, the proxy drops the browser's cookie and `Authorization` header and attaches a 60-second HS256 token naming the user, signed with `API_AUTH_SECRET`.
The API checks the token's signature, algorithm, issuer, audience and expiry, with 30 seconds of clock leeway, so the browser never holds a credential for it.

### 5.3 Accounts

Sign-in uses OAuth and OpenID Connect through Auth.js, with Sign in with Vercel (OIDC with PKCE, state and nonce) and GitHub, so the platform stores no passwords.
There is no self-signup and no user database.
`AUTH_ALLOWED_USERS` lists the actor ids that may sign in, such as `github:desk-north`, or `vercel:*` to admit whoever the Vercel app lets sign in.
With the Vercel app's Sign-In Access limited to team members, `vercel:*` admits exactly the team, and Vercel checks membership on every sign-in.
An empty list admits nobody, so a deployment that forgets to set it fails closed.
`next dev` adds a name-only sign-in for local work, which production builds do not register.

The earlier plan for argon2id password accounts in `et-api` is dropped.
Identity providers already handle credential storage, multi-factor authentication and account recovery, and doing them again would add risk without adding anything.

### 5.4 Sessions

A session is an encrypted Auth.js JWT in an `HttpOnly`, `SameSite=Lax` cookie, which is `Secure` and `__Secure-` prefixed over HTTPS.
It ends 12 hours after sign-in however active it stays, which covers a trading day and forces a fresh sign-in each day.
Every request that reads the session checks its account against `AUTH_ALLOWED_USERS` again, so removing an id signs that person out on their next request.
Every sign-in issues a new cookie, which prevents session fixation.
Rotating `AUTH_SECRET` ends every session at once.

Still planned:

- Revoking one person's session without changing the allowlist needs server-side state, such as a per-user `sessions_valid_after` timestamp in `et-api` that the token check compares with the session's sign-in time.
- An idle timeout of 60 minutes, which needs the same state.

### 5.5 CSRF

The defense is `SameSite=Lax`, an origin check on every state-changing request, and JSON-only request bodies, with no CSRF tokens on the API.
The `SameSite=Lax` session cookie is delivered, and Auth.js protects its own sign-in and sign-out routes with a token of its own; the rest of this section is planned.
`SameSite=Lax` keeps the cookie off cross-site `POST`, `PUT` and `DELETE` requests and off cross-site subresource requests.
Lax still sends the cookie on top-level cross-site `GET` navigations, so `GET` handlers must not change state, and a test walks the router to enforce that.
Sibling subdomains count as same-site, so the web app's proxy will also require `Origin`, or `Sec-Fetch-Site: same-origin`, to match the public origin on every `/api` request other than `GET` and `HEAD`, and reject the request when both headers are missing.
Mutating endpoints will accept only `application/json`, which a cross-origin form cannot send without a preflight, and `et-api` allows no cross-origin requests.
Double-submit tokens add a round trip without covering any case the origin check misses in a single-origin deployment, so they are deferred until the API is ever served cross-origin.

### 5.6 Rate limiting

Password guessing and account lockout are the identity provider's concern, because the platform has no passwords.
Expensive endpoints such as tuning, training and backtests will have per-user limits that protect the solver and model workers.
The counters live in Postgres, so they survive restarts and are shared across instances.
Sign-in, refused sign-in, sign-out and role changes will all be audit events.

### 5.7 Roles and authorization

There are four roles: `viewer`, `trader`, `risk` and `admin`, and a user can hold more than one.
`admin` manages users and the system and grants no trading rights, which keeps duties separate.
`et-api` stores roles against actor ids, and the web app's token carries only the identity, so a role change takes effect on the next request without anyone signing in again.

| Action | viewer | trader | risk | admin |
| --- | --- | --- | --- | --- |
| View workstation, forecasts, backtests, blotter | ✓ | ✓ | ✓ | ✓ |
| Export the blotter | | ✓ | ✓ | ✓ |
| Sync market data and train models | | ✓ | | ✓ |
| Build, edit and check bid sets | | ✓ | | |
| Submit a bid set | | ✓ | | |
| Approve a bid set | | | ✓ | |
| Withdraw a bid set before gate closure | | own sets | ✓ | |
| Edit or activate DSM policy and risk limits | | | ✓ | |
| Manage users, roles and sessions | | | | ✓ |
| View the audit log | | ✓ | ✓ | ✓ |

Authorization is denied by default.
Every route declares the permission it needs, and a test enumerates the router to make sure none is missing.
Command handlers also receive the `Actor` with its roles and check permissions inside the domain, so a new route cannot bypass them.

### 5.8 Four-eyes approval

A bid set needs approval from a second user with the `risk` role when its total exposure exceeds `FOUR_EYES_THRESHOLD_INR` or its verdict is `APPROVED_WITH_FLAGS`.
The approver must differ from the submitter, which is enforced in the state machine and again by a check constraint on the projection.
Approval binds to the content hash from 3.6, and it lapses at gate closure.
Below the threshold, approval is automatic and recorded as an `AutoApproved` event naming the rule that allowed it.

### 5.9 Audit actor

Audit entries already record the signed-in user's actor id, `<provider>:<username>`, from the API token, and the nightly pipeline records itself as `scheduler`.
An API running without `API_AUTH_SECRET` records every caller as `local`.

Still planned: every event records `actor_kind` and `actor_id`, and system work runs as a named system principal, never as a null actor.
Requests forwarded to the forecast service carry the actor in an internal header set by `et-api`, and the facade strips any copy of that header from inbound requests.
The `trader` default on `audit_log.user` goes away.

### 5.10 Authenticated WebSocket

The WebSocket connects to `et-api` directly (3.3), where the web app's session cookie is neither sent nor readable, so it authenticates with a ticket instead.
The client first calls `POST /api/ws/ticket`, which goes through the proxy like any API call, and `et-api` answers with a random ticket bound to the actor that is valid once, for 30 seconds.
The client then opens `/ws/blotter?ticket=...`, and `et-api` redeems the ticket and checks the role before upgrading.
A ticket in a URL can end up in access logs, which is why it is single-use and short-lived.
The `Origin` header is checked against the allow-list on upgrade, because WebSockets are not covered by CORS and would otherwise be open to cross-site hijacking.
`et-api` closes the connection with code 4401 when the actor's access is revoked, with revocation delivered over `LISTEN/NOTIFY`.
The client then asks for a new ticket, which redirects to `/login` if the session has ended.

### 5.11 Where auth lives

The web app owns sign-in and sessions through Auth.js, and the API trusts only the signed token its proxy attaches.
`et-api` will own roles, authorization and revocation, keyed by actor id, and the forecast service trusts only `et-api` over the private network.
Moving sign-in into `et-api` was considered and rejected: Auth.js already implements OIDC correctly on the host the web app runs on, and the token boundary keeps browser sessions out of the API entirely.
Corporate single sign-on is one more OIDC provider in `frontend/src/auth.ts`, such as Microsoft Entra ID or Okta, with identity-provider groups mapped to roles.

## 6. Delivery plan

Sizes assume one engineer working full time.

| Phase | Scope | Exit criteria | Size |
| --- | --- | --- | --- |
| 1. Foundations | Delivered: sign-in with Vercel and GitHub, the signed API token, the landing page and `/login`, and named actors on audit entries. Remaining: Postgres with SQL migrations and a one-off SQLite import; `et-api` skeleton as a pass-through facade that verifies the token; roles; Docker Compose | Every current workflow passes an end-to-end test behind sign-in; the forecast service is reachable only from `et-api`; imported row counts reconcile; CI runs migrations and both test suites against Postgres | 2 to 3 weeks remaining |
| 2. Blotter on existing data | Delivered: session rows from SQL aggregates over existing tables, list, detail and CSV endpoints, and the blotter UI with 15-second polling | All historical bid sets appear with derived clearing status; filters, totals and paging are covered by API tests | Delivered |
| 3. Rust core | `et-domain`, `et-policy` with immutable versions, `et-risk`, `et-store` and the event store; parity fixtures and route-by-route cutover; lifecycle and four-eyes approval; order-level blotter rows with benchmark cost; the WebSocket blotter; optimizer parity | Python policy, approval, risk and bid routers are deleted; the parity suite and property tests pass in CI; four-eyes approval is enforced; the blotter targets in 4.6 hold on 300 thousand seeded orders; keyboard and accessibility checks pass | 6 to 8 weeks |
| 4. Modeling | Buyer LP and per-block load schedule as a new strategy version; quantile intervals with conformal calibration; scenario risk; strategy backtests through `et-clearing` | Over at least 90 walk-forward delivery days, the new formulation costs less in procurement, RTM cover and DSM than the current one at equal or lower CVaR; 95% intervals cover 92 to 98% of held-out outcomes; the old formulation is retired | 4 to 6 weeks |
| 5. Market access | Bid curves and block bids in the optimizer and UI; bid areas and area prices; order routing through an exchange member; reconciliation with exchange obligation reports; settlement | Defined once exchange access is arranged | Not sized |

Phase 2 read existing tables only, which is why it could ship before phase 1's move to Postgres.
The order-level blotter moved into phase 3, because the forecast and risk context it reports is only stored once bid sets are event-sourced.
Phase 5 depends on a commercial relationship with an exchange member as much as on engineering.

## 7. Testing and operations

### 7.1 Tests

- Property tests with `proptest` cover the policy math: penalties are zero without deviation, never decrease as deviation grows, are continuous at the band edges, scale linearly with price and duration, and the severe tier never costs less than the base tier.
- Random command sequences against the state machine never reach an illegal state, and a submitter can never approve their own set.
- Every LP solution satisfies its constraints, and its objective is never worse than the uniform fallback.
- Parity tests replay the recorded fixtures from 3.10.
- Contract tests validate forecast runs against the JSON Schema and fail on OpenAPI drift.
- `et-store` tests run against a real Postgres in CI, with no database mocks.
- Playwright covers the full flow: a trader forecasts, optimizes, checks and submits a set above the threshold, a risk user approves it in a second browser context, and the trader's blotter updates live.
  The same suite covers refusals: a viewer cannot submit and a trader cannot approve their own set.
- A small `et-loadtest` binary drives 500 WebSocket clients at 20 events per second and reports commit-to-receive latency and server memory; it runs nightly rather than on every pull request.
- Dependency audits run in CI for Cargo, npm and Python.

### 7.2 Observability

Services log structured JSON through `tracing` on the Rust side and the standard logging module on the Python side, with a request ID on every line.
W3C `traceparent` headers propagate from Next.js through `et-api` to the forecast service, and traces and metrics export over OTLP to an OpenTelemetry collector.
Key metrics are latency and errors per route, solver time and status, how often the uniform fallback is used, verdict counts, WebSocket connections and send lag, event append rate, and forecast freshness per segment.
Alerts fire when no forecast for the next delivery day has been published a configured time before gate closure, when a nightly job fails, when the solver falls back, and when refused sign-ins or rejected API tokens spike.
`/healthz` reports liveness, and `/readyz` checks the database, the migration version and the forecast service.

### 7.3 Deployment

`et-api` builds in a multi-stage Dockerfile with `cargo-chef` layer caching onto a distroless runtime image.
The forecast service and its worker build on a slim Python image with `uv`.
The web app deploys to Vercel as described in [AUTH.md](AUTH.md), and builds as Next.js standalone output for local containers.
Migrations run as a one-shot job before the services start.
`docker-compose.yml` runs Postgres, migrations, `et-api`, the forecast service, the forecast worker and the web app locally, and `make dev` remains the entry point.
The nightly pipeline moves out of the API process into the forecast worker.
Any hosted environment is defined as code, and secrets come from the environment or a secret manager, never from images.
Postgres uses WAL archiving for point-in-time recovery, because the event store is the system of record, and a scheduled job proves that a restore works.

## 8. Open questions

1. Who is the primary user: a distribution utility's procurement desk that only buys, a trader that buys and sells, or a generator that sells?
   The data model reserves `side`, but the optimizer formulation differs for each.
2. Where does the per-block load schedule come from: an internal load forecast, the utility's own schedule, or uploads?
3. Which markets come first: IEX only, or other exchanges as well, and should TAM stay in the optimizer given its forecast accuracy?
4. Should RTM be optimized per half-hourly auction rather than as a day of 96 blocks?
5. What four-eyes threshold will the desk accept?
   Sessions last 12 hours from sign-in; whether the desk also wants an idle timeout is open.
6. Answered: the web app runs on Vercel with Sign in with Vercel or GitHub, and the API runs on a container host or virtual machine behind HTTPS.
   Whether a corporate identity provider replaces them depends on who the primary user is (question 1).
7. How long must events and market data be retained for regulatory record keeping?
