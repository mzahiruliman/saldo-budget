# Controlled rollout: Activity + iPhone Shortcuts

## Status and approval boundary

This feature branch prepares an upgrade to the existing Saldo installation. A pull request is **not** a deployment. Do not merge it, apply the migration to the live project, or deploy the function until the account owner explicitly approves that release. No paid project, branch, upgrade or service is required or enabled by these files. Existing platform quotas still apply; a public endpoint is not an unlimited free service.

The existing monthly planner, its document revision, and private budget remain intact. Do not replace the live budget with a developer fixture or reimport an older backup for this upgrade.

## Preflight

1. Export the latest **plan backup** in the running app. Keep it private, outside GitHub. After this upgrade, export actual transactions separately in Activity.
2. Review `migrations/002_tracker.sql`, `TRACKER-DATABASE-VERIFICATION.md`, the function files and the pull request. Run `npm ci`, `npm test`, `npm run build`, `npm run test:ui`, `/usr/bin/python3 database-test.py` and `/usr/bin/python3 tracker-db-test.py` in a disposable development environment with PostgreSQL and psycopg2 installed. These Python scripts create synthetic auth users and MUST NOT run against a live project.
3. Check that the approved target is Supabase project `cxezfmlzvyodmjxtjtzb` and GitHub repository `mzahiruliman/saldo-budget`, publishing `main /docs`. Preserve the existing OAuth/registration settings; this feature does not open signup.
4. If PostgREST is installed, run `/usr/bin/python3 tracker-http-test.py` for the local real-HTTP/real-PostgreSQL test. This uses synthetic, locally signed JWTs, not live OAuth or a real iPhone.

## Release order — only after approval

1. **Database first:** apply the complete `migrations/002_tracker.sql` as one additive migration using Supabase `apply_migration` (name such as `add_tracker_ledger`). Its transaction creates the ledger, private capability/rate tables and narrow RPCs. It does not update `budget_documents`. Do not run the test fixtures in production. Read back tables, function grants/RLS and Realtime publication membership after applying.
2. **Function second:** deploy `supabase/functions/shortcut-entry/index.ts`, its local `handler.mjs` and `deno.json` under function name **shortcut-entry**. Set **verify_jwt=false for this function only**. The device credential is not a Supabase JWT; its SHA-256 digest, expiry, revocation and permissions are validated inside the restricted database RPC on every call. Missing or invalid device credentials must fail. The function must never be left as an unauthenticated write handler.
3. **Public configuration only:** the function reads `SUPABASE_URL` and platform-provided `SUPABASE_PUBLISHABLE_KEYS` (JSON); it also supports the CLI's singular `SUPABASE_PUBLISHABLE_KEY`, optional local `SB_PUBLISHABLE_KEY`, and the legacy public `SUPABASE_ANON_KEY`. No service-role or secret key is used or requested. Do not add one to Shortcuts, browser code or this repository.
4. **Frontend last:** merge the reviewed branch after the backend is verified; publish the rebuilt `docs/` through the existing Pages `main /docs` configuration. Read back the published assets and inspect Activity. A local build is not proof of deployment.
5. Keep the old frontend commit available until the live checks below pass. Do not delete the original budget backup.

## Read-only live checks

- `public.transactions` exists, RLS is enabled, `authenticated` can SELECT only its own rows, and neither anon nor authenticated has direct INSERT/UPDATE/DELETE/TRUNCATE grants.
- Public RPCs for normal app operations require authenticated `auth.uid()`. `saldo_private` table/helper access is denied to anon/authenticated. Only `shortcut_metadata` / `shortcut_record` deliberately accept anon calls, and both require a valid device capability.
- `supabase_realtime` contains `public.transactions`. Verify Realtime SELECT authorization; don't add broad grants to make it connect.
- The function responds **401** with no credential; test with a missing header, not a credential pasted into a URL. An unknown token must not create a transaction or disclose accounts.
- The function uses public project configuration and does not log request bodies, headers, tokens or database error stacks.

## Owner smoke test — explicit test entries in the real account

These are intentional data writes, so obtain approval for test entries or let the owner perform them:

1. Sign in to Saldo, open Activity, record one identifiable small expense and confirm its receipt/history/actual totals. Verify monthly salary, Ibu deduction, planned items, paid flags and document revision did not change because of that transaction.
2. Pair the iPhone in Activity. Copy the private token once into **your private Shortcut**. Do not send it in chat, put it in a repository or include it in a backup. Follow `SHORTCUTS.md`; there is no pre-signed importable Shortcut in this Linux build.
3. Fetch account metadata with the token, then POST one confirmed transaction. Retry the **same UUID and identical payload**: response must say `duplicate:true`, with only one ledger row. Do not generate a new UUID to retry an uncertain request.
4. Confirm the open app updates via Realtime; close/reopen it and verify the same entry loads. Test a brief disconnect/reconnect; Refresh activity remains available and the connection label must not falsely claim live updates.
5. Test an own-account Transfer: bank movement changes but income/expense totals do not. Credit-card repayment is an own-account transfer, not a second purchase expense.
6. Resolve an Unassigned income/expense with **Assign account**. Its movement moves to that account without recording a second transaction. Void test entries afterward if desired; voids remain in history and are excluded from actual totals.
7. Revoke the iPhone credential and confirm subsequent calls fail. Create a new credential only if you intend to keep the Shortcut in use.
8. Export plan and transactions separately. Transaction exports contain all months/voided rows, no credentials; the current app does not offer a transaction-JSON restore UI. Keep both private.

## Rollback

Revert the frontend to its previously working commit and disable/remove the new function if needed. Revoke device capabilities through the authenticated device UI before removing it, or use an authorized administrative operation. Leave the additive ledger tables/data in place for investigation and recovery; do not drop tables or erase transactions as an automatic rollback. The original planner remains independently usable.

## Limits and honest boundaries

- Actual activity is separate from planned amounts; no automatic salary overwrite, Ibu deduction, paid-flag change or plan editor reload occurs.
- Account figures are **recorded net movement**, not actual balances. Dated opening balances would be required before presenting actual bank balances.
- Income/expense may be Unassigned; transfers require two definite, distinct owned accounts. Merchants/employers are external text, not required bank accounts. Deleted account routes retain stored name snapshots.
- Shortcut capabilities permit only account/category choices and new entries, not reading the ledger/budget, voiding, assigning accounts, pairing other devices or changing the plan. Authentication still controls normal app operations.
- Valid-device calls have atomic per-device/per-owner minute limits. Unknown-token traffic still consumes some platform/network resources; these controls are not IP-level DDoS protection or a guarantee against quota usage. Do not publish a private token or enable paid services to work around an error.
- Shortcuts must retain pending UUID + payload before sending if retry safety across app closure is needed. See the manual private-outbox recipe; automatic background delivery is not included.

Official authentication reference: https://supabase.com/docs/guides/functions/auth
