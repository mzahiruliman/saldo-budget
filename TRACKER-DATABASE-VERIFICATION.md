# Tracker database verification

## Scope and actual execution

Implemented `migrations/002_tracker.sql` and `tracker-db-test.py`. The original
`database.sql`, `database-test.py`, planner/frontend files, and existing document
schema were not changed by this database task. No Supabase connection, live DDL,
real user payload, service-role credential, commit, or push was used.

Run inside the disposable Linux sandbox as root:

```sh
/usr/bin/python3 tracker-db-test.py
/usr/bin/python3 database-test.py
```

Actual results on PostgreSQL **17.11 (Debian 17.11-0+deb13u1)**:

- Tracker suite: **25 tests passed** (subtests are not counted as separate tests).
- Existing document suite: **9 tests passed**.

The new script imports the existing `database-test.py` cluster harness with
`importlib`: `initdb`, socket-only `pg_ctl`, synthetic `auth.users`, actual
`anon`/`authenticated` SQL roles, real connections and SQL execution, and a
`finally` block stopping/removing the cluster. It does not read a network DSN or
connect to Supabase. The existing hostile default table grants are deliberately
retained in the harness so migration REVOKEs are exercised. Runtime-generated
synthetic tokens are never written to repository fixtures or output.

The supplied host path `/Users/zahirul` does not exist in this Docker backend.
Work used the explicitly supplied shared repository `/root/saldo-tracker` on
`feat/ios-shortcuts-tracker` instead.

## RED/GREEN evidence

Feature slices were exercised against real PostgreSQL before their corresponding
implementation, then rerun to green:

- Missing ledger: `to_regclass('public.transactions')` returned NULL.
- Missing metadata/record slice: `tracker_metadata()` was undefined.
- Missing summary/void slice: `tracker_summary(text)` was undefined.
- Missing capability lifecycle: `create_shortcut_device(...)` was undefined.
- Missing device throttle: 16 concurrent calls succeeded where only 5 should.
- Missing Realtime registration: publication membership was 0 instead of 1.
- Missing complete export: `export_transactions()` was undefined.
- Missing assignment RPC: `assign_transaction(uuid,text,text)` was undefined;
  added it, then passed the assignment/replay slice and the full suite.
- Explicit USD/object/null currency was silently accepted; currency slice failed,
  then passed after strict MYR string validation.
- Reserved owner/source keys were silently accepted; rejection slice failed,
  then passed after rejecting `owner`, `owner_id`, `user_id`, and `source`.
- Oversized direct-RPC JSON was accepted; byte-bound slice failed, then passed
  with `pg_column_size(p_entry) <= 8192`.
- First malformed shortcut record raised SQL rather than a committed error result;
  failed-attempt quota slice failed, then passed with an inner record savepoint.
- Metadata volatility audit: `device_metadata` was incorrectly IMMUTABLE rather
  than STABLE; corrected because timestamptz JSON formatting follows session zone.

Additional validation, ownership, replay, expiry, DST, export-size, and
cross-device concurrency regressions are included in the final green suite.

## Public contracts

All functions below are postgres-owned SECURITY DEFINER functions with
`search_path = ''`; relation/helper names are schema-qualified. PUBLIC gets no
EXECUTE grants. Authenticated-only functions obtain the owner from `auth.uid()`
and raise `SALDO_UNAUTHENTICATED` when absent:

| RPC | Result |
| --- | --- |
| `tracker_metadata()` | `{accounts:[{id,name,type}], categories:[commitment,entertainment,savings]}` |
| `record_transaction(p_entry jsonb)` | `{transaction: row, duplicate: boolean}` |
| `assign_transaction(p_transaction_id uuid,p_account_id text,p_category text)` | Updated row directly; own active unassigned income/expense only |
| `tracker_summary(p_month text)` | Integer-cent income/expense/transfer/unassigned totals and signed per-account `movements` |
| `list_shortcut_devices()` | Metadata array, without token hashes, raw tokens, or user IDs |
| `create_shortcut_device(p_name text,p_token_hash text,p_time_zone text,p_expires_in_days integer DEFAULT 90)` | Device metadata; 1–365 days, name 1–80 characters |
| `revoke_shortcut_device(p_device_id uuid)` | Boolean; own existing device returns true, including retries; foreign/missing returns false |
| `void_transaction(p_transaction_id uuid)` | Own row, idempotent; foreign/missing raises `SALDO_TRANSACTION_NOT_FOUND` |
| `export_transactions()` | All own rows including voids, ordered `occurred_at,id`, as one scalar JSON array from one aggregate/read snapshot |

`shortcut_metadata(p_token text)` and `shortcut_record(p_token text,p_entry jsonb)`
are executable by anon and authenticated without a service-role credential.
Every invocation validates format, SHA-256 digest, expiry and revocation, derives
its owner exclusively from the token's device, and shares the same device/owner
quota. Shortcut metadata adds the device's `time_zone`; shortcut recording
replaces the request's zone with that zone. It never accepts an owner from JSON.

## Ledger and validation

- `public.transactions` is a separate additive table, FK-bound to `auth.users`,
  with UUID PK and `(user_id,request_id)` uniqueness. Authenticated has owner-only
  RLS SELECT and no direct writes; anon has no table access.
- Income, expense and transfer use positive integer cents up to 10,000,000,000;
  currency is MYR. An explicit currency must be the JSON string `"MYR"`; absent
  currency defaults to MYR, while null, USD and nonstrings are rejected.
  The original JSON input and normalized helper input must each satisfy
  `pg_column_size(p_entry) <= 8192` bytes (a database JSONB-size bound, not
  identical to the Edge HTTP-body byte bound). Reserved `owner`, `owner_id`,
  `user_id`, and `source` keys are rejected even if null or equal to the true
  owner; owner and source are exclusively server-derived.
  Numeric strings, booleans, fractional/out-of-range values,
  invalid UUIDs, timestamps without explicit ISO offsets, and unrecognized
  PostgreSQL IANA-zone names are rejected with `SALDO_INVALID_ENTRY`.
- `entry_date` is a stored generated date from `occurred_at AT TIME ZONE time_zone`.
  App requests default to UTC when the zone is omitted/null. DST and month
  boundaries are tested with an unrelated connection session time zone.
- Owned financial account types are bank/wallet/cash/card/investment only.
  Recipient, external, unknown and foreign IDs raise `SALDO_ACCOUNT_CHANGED`.
  Names are snapshotted; historical replays remain valid after account rename or
  removal. Income/expense may explicitly omit their own side as unassigned;
  transfers require two distinct nonempty owned accounts. Expense has no to-side;
  income has no from-side. Only expenses can carry the three categories.
- External party is limited to 160 characters; note to 500. Optional absent/null
  values normalize equally. Canonical comparison normalizes amounts and timestamp
  instants, excludes mutable account names, source and unknown JSON keys, and
  compares all accepted transaction fields. Owners may see `canonical_entry` in
  their own rows/acks/exports. No device secrets occur there.
- Per-owner serialization plus the unique constraint makes concurrent identical
  requests yield one insert and duplicate acknowledgments. Changed canonical
  payload raises `SALDO_DUPLICATE_CONFLICT`. A replay of a voided transaction does
  not resurrect it. Voids are excluded from summaries but included in exports.
- Assignment obtains ownership from `auth.uid()` and locks the owner-bound row
  before checking it is active, nontransfer and still unassigned. Two racing
  assignments produce one success and one `SALDO_INVALID_ENTRY`. Missing/foreign
  transactions raise `SALDO_TRANSACTION_NOT_FOUND`; missing/foreign/recipient/
  external accounts raise `SALDO_ACCOUNT_CHANGED`. It snapshots the current
  financial account name, fills the correct income/expense route, and permits
  expense category null/commitment/entertainment/savings, income category null.
  No schema field or assignment timestamp was needed. It never changes
  `canonical_entry`: replaying the original app/shortcut request acknowledges
  the same updated row as a duplicate, without overwriting assignment.
  Tests check unassigned totals move into signed bank movements, account rename
  snapshotting, nonowner/anon/no-auth refusal and unchanged budget documents.
- Summary month must be `YYYY-MM`; transfers affect signed account movements but
  never inflate expense or income totals. Explicit unassigned amounts have their
  own totals, not fabricated account movements.

## Device and quota behavior

`saldo_private` schema, all its tables, and all its helper functions revoke all
PUBLIC/anon/authenticated access. Only lowercase SHA-256 hex digests are stored;
PostgreSQL's builtin `sha256(convert_to(token,'UTF8'))` is exercised end to end
against runtime-generated synthetic `sld_` + 43-character base64url tokens.

Registration is idempotent for the same owner/token hash, including eight
concurrent POST retries: it returns the original metadata without extending
expiry or changing name/zone. A hash belonging to another owner is rejected.
Expired/revoked registrations are not silently reactivated by a retry. No active
per-owner device-count cap is imposed (the proposed cap was optional).

Conditional row-locking UPSERTs enforce **60 authorized attempts/device/minute**
and **120 authorized attempts/owner/minute**, shared across shortcut metadata and
record RPCs. A valid credential's malformed record, stale account and duplicate
conflict consume quota when the outer RPC transaction commits, not just a
successful write. Windows are server-clock fixed calendar minutes, not sliding
windows. There is one bounded counter row per owner/device, reset on the next
window; no unbounded request log. Device and owner successful-call boundary tests
start at 55/115, race 16 real connections, and assert exactly 5 successes and 11
`SALDO_RATE_LIMIT` errors. A malformed-record concurrency test also starts at 55,
returns exactly 5 counted errors and 11 rate denials, leaves both counters at 60,
and writes zero ledger rows. Another test submits 60 malformed records and
verifies both metadata and record attempts are then rate-limited. Owner quota is
shared across different devices and isolated between owners.

`shortcut_record` authorizes outside its inner `BEGIN/EXCEPTION` savepoint.
Record validation, stale-account and duplicate-conflict failures return only:

```json
{"error_code":"SALDO_INVALID_ENTRY"}
```

The other allowed codes are `SALDO_ACCOUNT_CHANGED`,
`SALDO_DUPLICATE_CONFLICT`, and fallback `SALDO_TRACKER_ERROR`. This is a normal
SQL/HTTP-200 JSON result, **not a positive acknowledgment**: there is no
`transaction` or `duplicate` field. The Edge handler must inspect `error_code`
before success processing and map allowlisted codes to safe HTTP errors. Unknown
SQL exceptions never expose their messages, details, data or tokens. A genuine
post-insert trigger failure test verifies generic sanitization and rolls back
both the ledger insert and synthetic budget side effects while quota persists.
Authenticated app `record_transaction` still raises SQL errors on invalid input.

Invalid, unknown, expired or revoked tokens raise `SALDO_DEVICE_UNAUTHORIZED`;
over-limit authorization raises `SALDO_RATE_LIMIT`. Those exceptions remain
outside the record savepoint and roll back that denied call's quota changes.
These are bounds per **known valid credential**, not an invalid-token/IP abuse
limit. There is no guarantee all public HTTP requests consume quota: gateway
validation/rejection before RPC, unauthorized credentials, SQL argument decoding
errors, canceled statements and explicit outer transaction rollback may consume
none. The HTTP gateway/WAF needs its own anonymous-abuse controls. Counters persist
only when the outer SQL transaction commits.

## Reruns, preservation and remaining deployment checks

The migration uses additive `IF NOT EXISTS` tables/indexes, replaceable functions,
explicit grants, and a recreated owner-select policy. Reapplying it preserves
ledger rows, device registrations and existing budget payload/revision/timestamps.
It does not update salary, items, paid flags or planned transfers.

`public.transactions` is added to `supabase_realtime` only when that publication
exists and does not already include the table. Tests exercise absent publication,
then creation, then repeated reruns with data preserved. The test checks catalog
membership, not a running Supabase Realtime/WebSocket service.

The export test returns **1,006 own rows**, including a void, demonstrating a
scalar aggregate rather than SQL row pagination. No live PostgREST timeout/body
limit or deployed Realtime transport has been tested. Actual deployment remains
for the parent agent after explicit approval; this work makes no live-deployment
claim.
