# Local verification — Saldo cloud upgrade

## Checks actually executed

- `npm test`: **28 passed, 0 failed**.
- `npm run build`: **passed**; generated GitHub Pages files in `docs/`.
- `npm run test:ui`: **11 passed, 0 failed** in Chromium.
- `/usr/bin/python3 database-test.py -v`: **9 passed, 0 failed**, real PostgreSQL 17.11, fresh socket-only disposable cluster.
- `npm audit`: **0 vulnerabilities** in the installed dependency tree at the time of the check.

The browser tests exercise the actual UI, compiled app, Supabase JS SDK and sync engine with **explicitly simulated Supabase HTTP and synthetic test sessions**. They are not proof of a real OAuth login or a successful request to the user's Supabase project.

## Important coverage

- Signed-out gate shows no budget and rejects privileged-key input.
- Acknowledged cloud saving and retrieval in separate browser contexts.
- Mobile-width item editing and saving under a repository subpath.
- Stale writes stop with a conflict rather than replacing newer data.
- Initial cloud-load failure preserves edits and supports a safe retry.
- Recovery of pending drafts; cached draft is rendered before slow initial load completes.
- Delayed success/failure of an account-A import cannot affect account B.
- Invalid cached data is never rendered or written.
- Delayed SDK token lookup cannot attach account B's token to an account-A snapshot.
- Truthful pending/saving/saved indicators and cache-error reporting.
- Edits arriving during slow reload are preserved and rescheduled only when their base revision is safe.
- Real PostgreSQL owner-only reads, denied anonymous/direct writes, validation, idempotent redeployment, stale-revision preservation and concurrent saves.

A private-seed scan of the public source and built output found no original salary, budget figures, private source PDF, or imported personal backup. Screenshots and the original local app are outside the release. Fonts are bundled with their licenses. No paid service or external deployment is enabled by these files.

## Review status

Initial independent review found three lifecycle issues; a separate fix context reproduced and fixed them and added regression tests. Full-code re-review accepted the security and sync fixes and found one stale-editor issue. A second targeted fix and two browser regressions corrected it. Final independent focused review passed with no remaining security or logic findings in its scope. The consolidated verdict and scope are recorded in `REVIEW.json`.

## Live verification still required

- Run `database.sql` on the authorized Supabase project.
- Configure the publishable key through the app's connection screen (or explicitly embed it and rebuild).
- Publish `main /docs` through GitHub Pages.
- Complete real GitHub OAuth and verify redirects.
- Import the user's latest private browser backup and wait for a real cloud save acknowledgement.
- Verify that same data appears after signing in on the user's second device.

None of those live steps were performed during local development. The original local Saldo files and the user's browser data were not changed.
