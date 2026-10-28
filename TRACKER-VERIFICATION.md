# Tracker release verification — October 28, 2026 (UTC)

## Executed against this feature checkout

| Check | Result |
| --- | --- |
| `npm run build` | Passed; regenerated `docs/` |
| `npm test` | 54 passed |
| `npm run test:ui` | 32 passed in Chromium |
| `/usr/bin/python3 database-test.py -v` | 9 passed in disposable PostgreSQL |
| `/usr/bin/python3 tracker-db-test.py -v` | 25 passed in disposable PostgreSQL |
| `/usr/bin/python3 tracker-http-test.py` | 14 protocol checks passed, plus independent SQL verification and cleanup |
| `deno check supabase/functions/shortcut-entry/index.ts` | Passed |
| `npm audit --omit=dev` | No known production dependency vulnerabilities reported |
| `git diff HEAD --check` | Passed |

Browser tests include the compiled repository-subpath app and actual Supabase JS SDK with explicitly simulated HTTP/session fixtures. The HTTP integration separately uses actual local PostgREST, signature-verified synthetic JWTs, the real SDK and Edge handler factory, and actual PostgreSQL. Its HTTPS-to-loopback transport rewrite does not fabricate response JSON. See `TRACKER-HTTP-VERIFICATION.md` for exact boundaries and output.

Phone-width tests cover ordinary save controls, transfer validation, unassigned assignment, pending-request retries, history pagination, token clearing and retained/late handlers. The compiled app was exercised at 390px and 1440px with no horizontal page overflow. Screenshots contain synthetic data and are not release files.

Permission/accounting checks verify owner-only reads and mutations; denied anonymous/direct writes; expiring/revocable hash-only credentials; no duplicate rows on identical retries; transfers excluded from income/expense totals; complete scalar transaction export despite a REST row cap; and no changes to the monthly planner document or revision.

## Review-driven regressions

Independent security/accounting review found no blockers. Frontend review identified two reproducible issues, then failing tests were added before fixes: repeated pairing now zeroizes the previous token textarea before replacing it, and history uses validated `(occurred_at,id)` cursors instead of shifting offsets. Timestamp precision is preserved; an exact remaining-row count also supports a REST cap smaller than the requested page. Browser tests cover disconnected concurrent inserts and explicit refresh; real HTTP tests page six timestamp-tied rows under a five-row cap without duplication.

## Repository privacy

A programmatic scan of the intended source/build files found no literal GitHub credentials, private device credentials, privileged Supabase keys, private keys, literal session JWTs or private PDF/backup/image archives. The public initial state is valid with zero salary and no planned items. The private original budget, portable app, screenshots and browser backups are not included. Automated scans complement review; they are not a universal secret-detection guarantee.

## Live boundary

GitHub authorization and a read-only Supabase query were verified. At the read-only check, the live planner table existed, the tracker table did not, and the Realtime publication existed. No tracker migration, function deployment, production data write or frontend merge was performed by these checks.

The manual `SHORTCUTS.md` guide is not an installed or signed Shortcut. Live Supabase integration, Realtime delivery, GitHub OAuth and physical-iPhone execution remain deployment/on-device acceptance steps. Transaction JSON has no restore UI; plan backup and transaction export are explicitly separate.

Follow `TRACKER-DEPLOYMENT.md` only after explicit rollout approval. Keep the live monthly budget and its existing backup intact.
