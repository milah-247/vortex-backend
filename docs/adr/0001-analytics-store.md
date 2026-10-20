# ADR 0001: Analytics store — TimescaleDB continuous aggregates

- **Status**: Accepted
- **Date**: 2026-09-28
- **Deciders**: Engineering Team
- **Technical Story**: Build an analytics layer for volume, fees, fill latency, and solver share per chain/token over time, powering `GET /api/v1/analytics/*`.

---

## Context and Problem Statement

Analytics questions ("weekly volume by chain pair", "fee revenue trend", "solver
market share") are expensive on the OLTP database and unsupported by the current
endpoints. Governance and growth decisions depend on them. We need a store that
can serve `1m`/`1h`/`1d` aggregations over a year within a `p95 < 200 ms` budget,
while staying isolated from OLTP writes and tolerating late-arriving data.

## Decision Drivers

- **Isolation from OLTP writes** — analytics ingestion must never contend with the
  intent/solver write path.
- **Pre-aggregated rollups** — `1m`/`1h`/`1d` buckets must be cheap to query over
  a year (no full scans of raw events).
- **Late-arriving data** — aggregates must be repairable when a fill is reconciled
  or ingested late.
- **Operational simplicity** — the stack already runs PostgreSQL + Prisma; a second
  datastore adds ETL and ops burden we do not yet need.
- **Idempotent ingestion** — events are keyed by a stable id so replays are safe.

## Considered Options

1. **TimescaleDB continuous aggregates (Selected)**
   - *Pros*: a PostgreSQL extension, so it reuses the existing Postgres image,
     connection, and tooling; continuous aggregates natively provide `1m/1h/1d`
     rollups, refresh policies repair late data, and retention policies drop raw
     data on a schedule. Idempotency via `ON CONFLICT (event_id, time) DO NOTHING`.
   - *Cons*: requires the `timescale/timescaledb` Docker image (the migration-rollback
     CI job's Postgres service must switch to it — a follow-up to #118). Exact p95
     over long ranges uses the `timescaledb-toolkit` approximate sketch.

2. **ClickHouse `ReplacingMergeTree` sink**
   - *Pros*: excellent for high-cardinality, append-heavy analytics; `ReplacingMergeTree`
     handles late-data updates naturally.
   - *Cons*: a second datastore, a second connection/ETL path, and a new ops surface.
     Not justified at this protocol's current event volume; the OLTP Postgres already
     handles our scale.

3. **In-repo materialized views on the OLTP Postgres**
   - *Pros*: zero new infrastructure.
   - *Cons*: couples analytics to OLTP writes, no time-series partitioning or
     retention, and poor query latency over a year.

## Decision Outcome

**Chosen Option**: **TimescaleDB continuous aggregates**.

### Key details

- **Hypertable** `analytics_fills` partitioned on `time`, primary key
  `(event_id, time)` for idempotent `ON CONFLICT DO NOTHING` ingestion.
- **Continuous aggregates** `analytics_fills_1m/1h/1d` store additive
  `sum(volume)`, `sum(fees)`, `sum(duration_ms)`, `count(*)`, plus a
  `uddsketch(duration_ms, 0.01)` for approximate p95 (via `timescaledb-toolkit`).
  `1h` rolls up from `1m`, `1d` from `1h`.
- **Retention**: raw 30 days, `1m` 90 days, `1h` 1 year, `1d` kept indefinitely.
- **Refresh policies** re-aggregate late-arriving data (e.g. reconciled fills).
- The application accesses the store behind an `IAnalyticsStore` interface, so the
  in-memory implementation (used in dev/tests) and the Timescale implementation
  (production) are interchangeable. See `src/analytics/`.
- **Chain-pair aggregates** `analytics_fills_chain_pair_1m/1h/1d` group by
  `(src_chain, dst_chain, src_token, dst_token)` with the same rollup chain,
  retention and refresh policies as the main aggregates.

### Metrics

`GET /api/v1/analytics/:metric` serves six metrics. All accept `interval`
(`1m`/`1h`/`1d`), `from`/`to` (Unix seconds, `[from, to)`), and the optional
`chain` (source chain) and `token` filters.

| Metric | Point shape | Source |
|--------|-------------|--------|
| `volume` | `{ start, volume }` | `analytics_fills_{interval}` |
| `fees` | `{ start, fees }` | `analytics_fills_{interval}` |
| `latency` | `{ start, avgMs, p95Ms, count }` | `analytics_fills_{interval}` (p95 from the sketch) |
| `solver-share` | `{ start, solver, volume, share }` | `analytics_fills_{interval}` |
| `chain-pair` | `{ start, srcChain, dstChain, volume }` | `analytics_fills_chain_pair_{interval}` |
| `slippage` | `{ start, avgBps, p95Bps, count, excludedCount }` | raw `analytics_fills` |

- **`chain-pair`** (issue #593) reports volume per source→destination corridor.
  It also accepts `srcChain` and `dstChain` filters; other metrics reject them
  with 400. Intents always settle on Stellar today, so new fills record
  `dst_chain = 'stellar'`. Rows written before migration
  `20261020000000_analytics_chain_pair_slippage` are not backfilled and appear as
  `dstChain: "unknown"`.
- **`slippage`** (issue #594) is `(quotedDstAmount - fillAmount) / quotedDstAmount`
  in basis points (the unit of `MAX_USER_SLIPPAGE_BPS`), truncated toward zero
  per fill. Negative values mean the fill beat the quote and are not clamped.
  Fills with no recorded quote are left out of `avgBps`, `p95Bps` and `count`
  and are counted in `excludedCount` instead. A p95 of a ratio does not roll up
  through continuous aggregates, so this metric reads the raw hypertable and
  only covers its 30-day retention window.
- **CSV** (issue #596): any metric returns `text/csv` with `?format=csv` or
  `Accept: text/csv`. Columns match the JSON point keys in the same order, and
  base-unit amounts stay strings so they are not rounded. JSON stays the default.

### Consequences

- **Positive**: one-year range queries hit pre-aggregated buckets (fast); late data
  is repaired by refresh policies; analytics is fully isolated from OLTP writes.
- **Negative**: the deployment Postgres must be the `timescale/timescaledb` image
  (`docker-compose.yml` is updated; the `migration-rollback` CI job's service
  container must follow). p95 is approximate (sketch error ≈ 1 %).
