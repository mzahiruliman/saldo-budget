# Database verification

## Result and scope

**Nine real PostgreSQL integration tests pass.** The final suite passed three consecutive fresh-cluster runs on PostgreSQL `17.11 (Debian 17.11-0+deb13u1)`. No live Supabase project was contacted or changed. No Supabase credentials are needed or present in these files. The fixture users and all payloads are synthetic.

Only these database deliverables were authored: `database.sql`, `database-test.py`, and this document. Frontend model validation and HTTP/PostgREST integration are outside this database-only task.

## Reproduce inside a disposable Debian/Linux sandbox

Run as root (the harness launches the server as the unprivileged `postgres` OS user):

```sh
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql python3-psycopg2
/usr/bin/python3 /root/saldo-cloud/database-test.py -v
```

Use `/usr/bin/python3` so Debian's `python3-psycopg2` is importable. The runner locates server executables through `pg_config --bindir`, initializes a fresh temporary cluster, listens **only on its private Unix socket**, creates fixture roles/auth helpers, deploys the real SQL, tests it, stops the server, and deletes the cluster in `finally`. It does not start or use the package's default cluster. Authentication is trust-only on that disposable private socket, not on a public TCP listener.

The fixture deliberately grants default table privileges to `anon` and `authenticated` before deployment, proving the deployment's explicit revocations work even with permissive defaults. Fixture `auth.uid()` reads `request.jwt.claim.sub`; each independent connection sets the role and synthetic claim. This simulates the database authorization boundary, **not JWT verification**, Supabase Auth, or the live API.

## Test-first evidence

Observed red/green sequence, using the command above:

1. Wrote schema contract test before `database.sql`. Real run failed: `AssertionError: unexpectedly None : budget_documents must exist after deployment`. Added table; `Ran 1 test ... OK`.
2. Added save/read/isolation/revision contract test. Real run failed because `function public.save_budget(jsonb, bigint) does not exist`. Added RPC plus SELECT RLS/permissions; `Ran 2 tests ... OK`.
3. Added invalid payload and size-boundary tests. Real run failed with `Error not raised` for invalid JSON objects and oversized content (and wrong conflict error after an invalid write). Added explicit validation; `Ran 4 tests ... OK`.
4. Added regression coverage for permissions, security metadata, foreign key, repeat deployment, and real concurrent connections; all passed without further production changes.

The final run's actual output:

```text
PostgreSQL: 17.11 (Debian 17.11-0+deb13u1)
Isolated socket-only cluster; synthetic auth users; no external connection.
test_01_schema_contract (__main__.DatabaseTests.test_01_schema_contract) ... ok
test_02_owner_save_read_and_revision_contract (__main__.DatabaseTests.test_02_owner_save_read_and_revision_contract) ... ok
test_03_validation_rejects_without_changing_document (__main__.DatabaseTests.test_03_validation_rejects_without_changing_document) ... ok
test_04_payload_size_limit_in_bytes (__main__.DatabaseTests.test_04_payload_size_limit_in_bytes) ... ok
test_05_anonymous_and_direct_writes_denied (__main__.DatabaseTests.test_05_anonymous_and_direct_writes_denied) ... ok
test_06_security_metadata_and_foreign_key (__main__.DatabaseTests.test_06_security_metadata_and_foreign_key) ... ok
test_07_redeploy_preserves_data_and_permissions (__main__.DatabaseTests.test_07_redeploy_preserves_data_and_permissions) ... ok
test_08_concurrent_initial_creates_one_document (__main__.DatabaseTests.test_08_concurrent_initial_creates_one_document) ... ok
test_09_concurrent_updates_commit_once (__main__.DatabaseTests.test_09_concurrent_updates_commit_once) ... ok

----------------------------------------------------------------------
Ran 9 tests in 0.366s

OK
```

Each concurrency test uses eight separate transactions, a start barrier, and holds the winning row lock briefly before commit. Assertions require **exactly one successful save and seven `SALDO_CONFLICT` responses**, then read the stored document back and match its payload/revision to the winning response. Both simultaneous initial insert and simultaneous revision-1 updates are exercised.

Other assertions cover anonymous SELECT/RPC denial; authenticated direct INSERT/UPDATE/DELETE/TRUNCATE denial; A-only SELECT visibility; B not updating A with A's revision; inert owner fields inside JSON; rejection of a third owner argument; missing authentication; foreign-key failure for a nonexistent account; stale/duplicate saves preserving data; fresh saves incrementing revision; exact 2 MiB acceptance, one-byte-over rejection, and UTF-8 byte counting; data and permissions surviving repeated deployment.

## Deployment and client contract

Deploy `database.sql` as the trusted `postgres` role in the target Supabase SQL editor **only when authorized**. It assumes Supabase's existing `auth.users`, `auth.uid()`, `anon`, and `authenticated`. Do not deploy the synthetic test auth fixture. Reapplication does not drop the table or stored documents; it replaces this function and its named policy in a transaction. This is repeat deployment of this schema, not an automatic migration from arbitrary incompatible preexisting tables/policies.

```sql
public.save_budget(p_payload jsonb, p_expected_revision bigint)
RETURNS SETOF public.budget_documents
```

The successful result has one row with `user_id`, `payload`, `revision`, `updated_at`. The set-returning contract is intended for ordinary Supabase `.rpc('save_budget', {p_payload, p_expected_revision})` consumption as a **one-element data array**, not a bare object. Actual Supabase/PostgREST serialization was not live-tested here; do not apply `.single()` unless intentionally changing client result handling.

- `p_expected_revision = 0`: create caller's document at revision 1; duplicate raises `SALDO_CONFLICT` (`P0001`).
- Positive revision: update only caller's matching revision, increment once, and update timestamp; absent/stale row raises `SALDO_CONFLICT`. No unconditional upsert or owner parameter exists.
- Authentication missing: `SALDO_UNAUTHENTICATED` (`28000`).
- SQL NULL/non-object JSON: `SALDO_INVALID_PAYLOAD` (`22023`).
- Canonical `jsonb::text` over 2,097,152 bytes: `SALDO_PAYLOAD_TOO_LARGE` (`22023`). This is a stored-document limit, not an HTTP request-body limit.
- NULL/negative expected revision: `SALDO_INVALID_REVISION` (`22023`).

The RPC is intentionally **SECURITY DEFINER**, owned by `postgres`, with empty `search_path`, schema-qualified references, explicit `auth.uid()` binding on every write, and no dynamic SQL. This prevents granting authenticated callers direct table writes (and revision tampering). PUBLIC/anon have neither table privileges nor RPC execution. Authenticated callers receive only public-schema usage, owner-filtered SELECT under RLS, and RPC EXECUTE. A trusted database administrator/service role remains privileged by design; never expose privileged credentials in the browser.

The database validates JSON object shape and size, not the full evolving Saldo model. The frontend must additionally validate the budget model before saving and after loading. Payload contents are not an authorization mechanism. Production authentication, project grants/policies, browser integration, and end-to-end cloud saves still need verification on the authorized target project.
