# Local tracker HTTP integration verification

## Result

**PASS: 14 protocol checks**, followed by independent SQL count/revision checks.
The final harness passed twice consecutively on fresh clusters. Its transport-negative
control also passed by detecting the expected first-save failure with PostgREST absent.
No application, API, Edge-handler, model, or migration implementation was changed by
this harness work.

This is **local protocol evidence**, not a live Supabase deployment, physical iPhone
or Apple Shortcuts execution, OAuth login, Realtime-server, or Deno-serving claim.
The real Edge handler **factory** runs in Node with native Request/Response objects.

## Executed environment and installation

- Linux `aarch64` sandbox; PostgreSQL **17.11**.
- PostgREST **16.5**, official release asset downloaded using authenticated `gh`.
- Node **v26.11.1**, installed real `@supabase/supabase-js` **2.118.0**.
- `/usr/bin/python3` with installed `psycopg2`.
- PostgreSQL data/socket directories are disposable; PostgreSQL listens on **no TCP
  addresses**. PostgREST listens on **127.0.0.1** with an OS-selected ephemeral port.
- `/tmp` is noexec; extraction there is fine, but the executable was installed at
  `/usr/local/bin/postgrest` before execution.

Commands actually executed from `/root/saldo-tracker`:

```sh
uname -m
# aarch64

gh release download v16.5 --repo PostgREST/postgrest \
  --pattern postgrest-v16.5-linux-static-aarch64.tar.xz --dir /tmp
tar -xJf /tmp/postgrest-v16.5-linux-static-aarch64.tar.xz -C /usr/local/bin
postgrest --version
# PostgREST 16.5

/usr/bin/python3 tracker-http-test.py --red-transport
/usr/bin/python3 tracker-http-test.py
/usr/bin/python3 tracker-http-test.py
```

Dependencies must already be installed. Missing PostgREST or a missing assignment RPC
is a hard error, never a silent skip or JSON/mock fallback. The harness intentionally
does not download executables or install packages each time it runs.

## Assertions-first and negative-control evidence

The Node probe's success assertions were written before the first protocol exercise.
Existing components were then verified unchanged. This is integration verification
of existing implementations, **not a claim that their implementation was newly
written through a red/green cycle**.

`--red-transport` applies the real schemas and creates synthetic identities but does
not start PostgREST. It requires a nonzero Node exit, the first named check's failure,
`fetch failed` plus `ECONNREFUSED`, and no completed PASS check. Observed:

```text
FAIL real signed-JWT SDK saves independent revision-1 owner documents
message: 'TypeError: fetch failed'
Caused by: Error: connect ECONNREFUSED 127.0.0.1:<ephemeral-port>
EXPECTED RED: first revision-1 SDK save assertion failed with transport absent.
CLEANUP verified: PostgREST stopped, PostgreSQL stopped, temp cluster removed.
```

## Real data and transport boundaries

The Python harness creates an isolated PostgreSQL 17 cluster, disposable `anon` and
`authenticated` roles, `auth.users`, and fixture `auth.uid()` that reads real
PostgREST `request.jwt.claims` JSON (with legacy single-claim compatibility).
It applies **`database.sql` and `migrations/002_tracker.sql`** unchanged.

Only synthetic users `11111111-1111-4111-8111-111111111111` and
`22222222-2222-4222-8222-222222222222` exist. Both save `initialState()` plus a
synthetic cash account through the actual budget API and SDK at revision 1.
The B fixture has a distinct bank name to identify owner isolation.

Every run generates a fresh, cryptographically random HS256 signing secret in memory.
The secret is passed to local PostgREST only through its process environment; signed,
short-lived owner JWTs go to the Node process. No fixed signing key, real user token,
service-role key, production URL, or real budget is used or stored. A tampered JWT
is rejected by actual PostgREST with HTTP 401 / `PGRST301`, proving the fixtures are
signature-verified rather than merely decoded.

The fake **primary session provider** returns these signed fixture sessions. Actual
`ownerClient`, `budgetApi`, and `createTrackerApi` instantiate/use the real Supabase
SDK. No SDK RPC return values or SQL responses are mocked.

The Edge factory retains its production HTTPS configuration guard using
`https://local.synthetic`. Its injected fetch changes **only the transport URL**:
`/rest/v1/...` becomes the real raw PostgREST path on loopback, preserving query
parameters, method, body, headers, and signal. No JSON is synthesized. Assertions
reject nonlocal transport destinations. Edge RPCs carry the synthetic publishable
`apikey` but **no upstream Authorization**; raw PostgREST ignores `apikey` and runs
these calls as the actual `anon` role, with device authorization enforced by SQL.

Privileged socket SQL in the probe is used only for fixture inspection and advancing
a disposable device expiry into the past. All budget saves, normal transaction writes,
assignment, void, pairing, revoke, metadata, list, summary, and export go through the
actual SDK or actual Edge-to-REST protocol.

## Verified behavior

1. Independent A/B revision-1 budget saves and exact reloads through signed-JWT SDK.
2. Tampered signed JWT rejected by real PostgREST.
3. Authenticated income, expense, transfer produce owned `source=app` rows. Initial
   totals: income 10000 cents, expense 1250, transfer 2000; movements bank 6750,
   cash 2000. Transfer is not counted as expense.
4. B explicitly filtering A's ledger and budget sees no rows; B cannot void A's row.
5. Anonymous REST ledger SELECT and authenticated-only record RPC are denied with
   HTTP 401 / SQL privilege code `42501`.
6. Device mint sends/stores SHA256 only; raw private token is returned only to the
   caller. The private stored hash matches the generated token; mint/device lists
   expose neither hash nor a raw stored key. B's device list is empty.
7. Edge GET returns current bank/cash choices, categories, and configured UTC zone
   through real anonymous capability RPC; excludes recipient/external pseudoaccounts.
8. Edge POST saves once; exact request-ID retry acknowledges `duplicate=true`, same
   transaction ID, and exactly one SQL row with that request ID and owner.
9. Changed retry payload gives 409, unknown account gives 409, string-valued cents
   gives 400. The **actual SQL RPC responses** are first checked to be HTTP 200 JSON
   `error_code` envelopes, then the real Edge factory maps them to the correct HTTP
   errors without false transaction acknowledgments.
10. Unassigned actual expense can be resolved once through the real assignment RPC;
    B assignment is denied, assigned routing/category are acknowledged, and unassigned
    summary becomes zero. A second assignment is rejected.
11. Six A rows are exported despite **`PGRST_DB_MAX_ROWS=5`**. Normal history really is
    capped at five; scalar aggregate JSON export returns all six and matches SQL count.
    This is small protocol-level truncation coverage, not a 1201-row benchmark.
12. Voiding an expense preserves history but changes actual expense total from 1600
    to 350 cents. Income remains 10500; transfer remains 2000.
13. Expired and revoked devices reject both GET and POST with HTTP 401. B cannot revoke
    A's device. A revoke is read back via the SDK device list before asserting denial.
14. Both complete budget document payloads, revisions, owners, and update timestamps
    remain exactly unchanged after actuals, assignment, void, pairing, and revoke.

## Latest review-fix rerun

After the original runs below, history cursor assertions were added inside check 11. The updated real SDK traverses both pages of six rows with identical occurrence timestamps under `PGRST_DB_MAX_ROWS=5`, reports another page after the first five, and matches the complete export without duplicate IDs. All 14 checks and independent SQL/cleanup checks passed again. The latest protocol request count is **50**, reflecting the additional history-page request; the historical output below records 49 for the earlier probe.

## Final output (both original repeated green runs)

```text
PASS 1 real signed-JWT SDK saves independent revision-1 owner documents
PASS 2 PostgREST verifies JWT signature instead of trusting decoded owner claims
PASS 3 authenticated income expense transfer have owner rows and separate summary totals
PASS 4 SDK B cannot select A ledger or document even with explicit A filters
PASS 5 anonymous REST cannot read ledger or invoke authenticated record RPC
PASS 6 pairing stores only private SHA256 hash; owner device lists never disclose it
PASS 7 Edge GET reads current SQL choices through anonymous capability RPC
PASS 8 Edge POST acknowledges actual commit once; identical retry returns duplicate
PASS 9 real SQL error_code JSON maps conflict and malformed input to Edge 409/400
PASS 10 real unassigned row can be assigned once through owner SDK RPC
PASS 11 scalar JSON export exceeds configured REST row page without truncation
PASS 12 void removes actual expense from summary but retains auditable history
PASS 13 device expiry and owner revocation block GET and POST with 401
PASS 14 all actuals pairing assignment void leave whole budget payload and revision unchanged
{"result":"PASS","checks":14,"ownerA_rows":6,"ownerB_rows":0,"rest_row_cap":5,"export_rows":6,"protocol_requests":49}
PASS independent SQL verification: A=6 rows, B=0; both plan revisions=1.
CLEANUP verified: PostgREST stopped, PostgreSQL stopped, temp cluster removed.
```

`protocol_requests` counts the SDK/Edge transport rewriter calls, not direct raw REST
negative checks or health probes. Counts are generated by execution, not hand-estimated.
A subsequent process inspection found no PostgREST or `saldo-http-` cluster processes.

Cleanup is in `finally`, including the deliberate red path and failed-probe paths.
PostgREST exit, removed PostgreSQL postmaster PID file, and removed temp directory
are asserted. Readiness is bounded at 20 seconds and Node execution at 90 seconds.
No commit, push, GitHub write, production deployment, or live Supabase call was made.
