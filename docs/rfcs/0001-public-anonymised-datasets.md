# RFC 0001: Public anonymised datasets

- Status: Accepted
- Author: backend team
- Issue: public daily datasets

## Summary

Publish daily, anonymised snapshots of protocol activity (intents, fills,
solver stats, and fees) as Parquet and CSV files to a public object-storage
bucket, each accompanied by a `manifest.json` carrying the schema version, row
counts, SHA-256 content checksums, and a high-water mark. A read-only
`GET /api/v1/datasets` endpoint lists the available dates and their schemas.

## Motivation

Community analysts currently scrape the live API, which is slow, rate-limited,
and inconsistent. A stable, downloadable dataset strengthens transparency and
attracts ecosystem builders without exposing the live database.

## Proposed change

- New `src/datasets/` module: schema registry + versioning, rotating-salt
  anonymisation, CSV/Parquet serialisers, manifest builder, object-storage
  abstraction, and the `DatasetsService`.
- New `scripts/export-datasets.ts` daily job, run by cron.
- New `GET /api/v1/datasets` and `GET /api/v1/datasets/schemas` endpoints.
- `manifest.json` per publication: schema id/version, row counts, SHA-256 of
  each file, and a `watermark` (the maximum event timestamp covered).

### Privacy decision (rotating-salt hashing)

User addresses are pseudonymised with HMAC-SHA256 keyed by a **rotating salt**:

- The base salt is a deploy secret (`DATASETS_SALT`) and never appears in any
  exported artifact or manifest.
- The active salt is derived per rotation window as
  `HMAC-SHA256(baseSalt, windowIndex)`; the base salt is never recoverable from
  a window salt.
- Default rotation is 24 h (`DATASETS_SALT_ROTATION_HOURS`). A small number of
  previous windows (`DATASETS_SALT_RETENTION_WINDOWS`, default 2) are retained
  so late-arriving data can still be matched to its window.
- Solver addresses are **not** hashed — they are public identities and must
  remain attributable for accountability.
- Anonymisation is on by default and can be disabled with
  `DATASETS_ANONYMIZE=false` (e.g. for testnet, where addresses are already
  public). In production the salt is mandatory and validated at startup.

This is a deliberate trade-off: rotation bounds cross-window linking of user
activity, while retained windows preserve within-window aggregation. It is not
a substitute for strong anonymity (full k-anonymity/l-diversity requires
aggregation, which is out of scope here), and that limitation is documented in
the dataset README.

### Schema versioning (additive-by-default)

Each dataset has a versioned schema (`major.minor`):

- **Additive** change (append a new *optional* field) → bump MINOR.
- **Breaking** change (remove, rename, retype, or make a field required) →
  bump MAJOR and reset MINOR to 0, creating a new schema id
  (`intents-v2.0`) so existing consumers keep working against the old contract.

`classifySchemaChange()` enforces this policy and is unit-tested.

### Reconciliation (late-arriving data)

Re-publishing a date increments the publication `revision` (1, 2, …) instead of
overwriting history. `manifest.json` records the revision so consumers can tell
a repaired publication from the original. The exporter keys artifacts under
`datasets/YYYY-MM-DD/rev-N/`.

### On-demand range export (issue #592)

Operators can export one dataset kind over a range of whole UTC days as a
single file:

```
POST /api/v1/admin/datasets/export
x-admin-key: <admin key>

{ "kind": "intents", "from": "2026-01-01", "to": "2026-01-31", "format": "parquet" }
```

- `from` and `to` are inclusive `YYYY-MM-DD` UTC days. Ranges longer than
  `DATASETS_EXPORT_MAX_DAYS` (default 31) are rejected with 400 instead of
  streaming a huge file.
- Rows come from the same builders as the daily job (`exportDaily` and
  `exportRange` share one code path), go through the same `Anonymizer`, and are
  serialised by the same `toCsv`/`toParquet`. Each row is hashed with the salt
  window active at its own timestamp, so a range that crosses a salt rotation
  still links users only within a window.
- `solver_stats` is a point-in-time snapshot and ignores the range, as in the
  daily export.
- The response body is the file. Its manifest is sent in response headers:
  `X-Dataset-Schema`, `X-Dataset-Schema-Version`, `X-Dataset-Kind`,
  `X-Dataset-From`, `X-Dataset-To`, `X-Dataset-Row-Count`, `X-Dataset-Sha256`,
  `X-Dataset-Generated-At` and, when rows exist, `X-Dataset-Watermark`.
- Parquet cannot represent an empty file, so a Parquet request for a range with
  no rows returns 404. CSV returns a header-only file.
- Exports are returned, not published: they do not create a revision under
  `datasets/YYYY-MM-DD/`, and the daily publication stays the public contract.
  The endpoint is admin-only and not part of
  `docs/public-transparency-contract.md`.

## Alternatives considered

- **Hosted query engine (DuckDB/SQL endpoint).** Rejected — explicitly out of
  scope; static files are simpler and cheaper to operate.
- **Full plaintext addresses.** Rejected — needlessly leaks user activity
  across datasets; hashing is cheap and reversible-by-policy.
- **One-time (non-rotating) salt.** Rejected — a single salt allows indefinite
  cross-dataset linking of the same user; rotation bounds this.
- **Aggregated-only (no row-level) export.** Rejected for v1 — row-level data
  is what researchers need; aggregation can layer on top later.

## Backward-compatibility impact

- No change to persisted data, the WebSocket protocol, or on-chain semantics.
- Purely additive: a new read-only API surface and a new module. Existing
  endpoints are untouched.
- `DATASETS_ENABLED` defaults to false, so the job is inert until an operator
  opts in.

## Related work

- `docs/public-transparency-contract.md` — the live stats contract this
  complements.
- `src/stats/` — source of the protocol-level aggregates.
