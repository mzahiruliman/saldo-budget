# Saldo · private cloud budget

Responsive monthly budget planner for GitHub Pages + Supabase Auth/Postgres. This repository intentionally contains **no personal starter budget**. Your real data belongs in the authenticated database and private JSON backups, never in the repository.

## Current delivery status

The app and database migration are provided for deployment. Local automated tests are separate from a successful live Supabase/GitHub OAuth deployment. No cloud account credentials are included. Nothing in this package automatically publishes a site or changes a live database.

## Activity and iPhone Shortcuts upgrade

The new **Activity** view records Income, Expense and own-account Transfer separately from the monthly plan. It supports explicit Unassigned income/expense, later account assignment, voiding, full-history transaction export and revocable per-device Shortcut credentials. Recorded account movement is not a verified bank balance. Neither transactions nor retries rewrite planned salary, Ibu, item amounts or paid flags.

For an existing installation, follow **[TRACKER-DEPLOYMENT.md](TRACKER-DEPLOYMENT.md)** after release approval. Apply the additive migration and deploy the restricted endpoint before merging the rebuilt frontend. Do not rerun old import steps or replace the current budget with fixtures. Build the private Shortcut using **[SHORTCUTS.md](SHORTCUTS.md)**; a pre-signed importable iPhone Shortcut is not supplied.

Plan backups and Activity transaction exports are **separate**. Export both; neither contains device credentials. The current app does not have a transaction-JSON restore UI.

## Accounts: plan versus actual

**Accounts & routes** shows each account's plan projection unchanged and, alongside it, the recorded movement for the selected month from Activity and the Shortcut. Enter the **actual opening balance** at the start of a month to get a tracked balance: actual opening plus recorded income, minus recorded expenses, plus or minus own-account transfers. Actual opening balances are dated the first of their month, accept negative card balances, and reset for a new month.

The tracked balance is not a live bank balance and the app does not connect to a bank. Recording a transaction never rewrites the plan projection, salary, Ibu, item amounts or paid flags. This upgrade stores the new optional field in the private budget document and requires **no database migration**.

## Deploy after creating your GitHub OAuth / Supabase project

1. Export a backup from your original local Saldo. Keep it private.
2. In Supabase **SQL Editor**, open a new query, paste `database.sql`, and run it. It creates the budget table, owner-only read policy, and revision-checked save function. It does not import any budget data. Review Supabase Security Advisor afterward.
3. Upload this repository's sanitized files, **including the prebuilt `docs` folder**, to the GitHub repository. Do not upload your backup, PDF, screenshots, or old HTML app. Keep `index.html` inside `docs` as supplied.
4. GitHub repository → **Settings → Pages → Deploy from a branch → main → /docs → Save**. This edition uses `/docs`, not the root folder described in the earlier generic walkthrough. No build server is required; compiled files are already present.
5. In Supabase **Authentication → URL Configuration**, verify both Site URL and an allowed redirect are exactly `https://mzahiruliman.github.io/saldo-budget/`. The GitHub OAuth app callback is the Supabase callback shown in its GitHub-provider settings, not the Pages URL.
6. Open your Pages website. If the connection screen appears, obtain the **publishable key** (`sb_publishable_…`) from Supabase → Project Settings → API Keys. Enter it **in the app**, not chat. This browser-only configuration must be entered once per browser/device. Never enter a database password, OAuth secret, `sb_secret_…`, or service-role key.
7. Click **Continue with GitHub**. After sign-in, open **Plan settings → Import backup** and choose your private JSON backup. Review the replacement confirmation and wait for **Saved to cloud**.
8. Open the site in a second browser/device, enter the same public connection key if requested, and sign into the **same GitHub account**. Verify your data. Change one small item and verify that the other device loads it after reopening or clicking **Load latest**.

If you see missing-table/function errors, verify step 2. For redirect errors, verify step 5. For `Failed to fetch`, check network access and whether your Supabase project is paused; do not disable RLS to fix connectivity.

## Saving and conflicts

- Save actions queue a short debounced cloud write; **Saved to cloud** appears only after a server acknowledgement.
- Pending edits are cached under a user-specific key in this browser. The cache and exported JSON are **not encrypted**. Use a trusted device.
- If the network fails, the app keeps the draft and reports **Not saved to cloud**. **Retry cloud save** first establishes the remote revision and then retries; it does not blindly overwrite the cloud.
- A stale revision produces a conflict, not last-write-wins. Export your draft if needed, then **Load latest** to discard the draft explicitly. Reapply wanted edits to the newest version.
- The monthly **plan** loads on sign-in/open and with **Load latest**; it is not continuous realtime co-editing. Activity has a separate authenticated Realtime subscription and reconnect refresh that never reloads the whole plan. Keep one editor active at a time when possible.
- Signing out clears the displayed budget. Discarding an unsaved draft to sign out requires confirmation; export first. Cloud records remain intact.
- Keep periodic JSON backups, especially before migration or replacing the app. The original portable edition stays independent and is not changed by this deployment.

## Security model

GitHub Pages publishes static code, not private budgets. Supabase identifies signed-in users. Row Level Security allows users to read only their own document. Writes go through a restricted database function that derives the owner from `auth.uid()` and atomically checks the expected revision. Browser code contains no privileged backend credentials. Other signed-in users receive separate blank budgets; this is data isolation, not a single-user allowlist. Restrict account creation separately if you do not want additional users consuming project quota.

The client validates imported/cloud state; the save function enforces authentication, object shape, size, and concurrency rather than validating every budgeting field. A user can only modify their own data. No bank connection or payment execution is provided.

## Five planning improvements (local feature branch)

1. **Chronological carry-forward and explicit scope.** New months inherit the latest earlier saved month's recurring forward plan, never whichever later month is selected. No predecessor means an empty breakdown. Add/edit/delete offers **This month onward** (default) or **This month only**. Onward stops at the first explicit saved override or different recurring snapshot. Retained IDs keep each target month's own paid state; new items start unpaid. Month-only edits preserve the previous recurring baseline even for future months not created yet. A later onward operation applies only its own item delta to that baseline; unrelated earlier month-only edits, additions and deletions stay local.
2. **Truthful persisted labels.** New carries record their source; edited months show **Own changes in this month**. Legacy documents show **Carry source not recorded**, without guessing. Identical explicit edits establish a boundary too.
3. **Optional month-start review.** Confirm income, review recurring items, enter opening balances if needed, and start unpaid are month-local confirmations only. They never change money, balances or paid flags; new months start unchecked.
4. **Recurring / One-off.** The item editor and breakdown show recurrence. Missing legacy recurrence means recurring. One-offs remain in their month and never enter inherited forward plans.
5. **Explicit replacement and bounded undo.** In Plan settings, choose the source and review exact later saved months, source definitions and before/after counts/totals. Replacing needs explicit consent, reset when the source changes; cancel does nothing. All target breakdowns, including overrides and one-offs, are replaced by unpaid recurring source items. Undo restores only the latest replacement's items/planning metadata, not newer income, targets, balances, transfers or review checkboxes. Any intervening item/paid/planning change rejects undo atomically. The undo snapshot is limited to 1.8 MB and exists only in the open session; reload, import, sign-out or loading another snapshot clears it. Export a backup for durable recovery.

Income, Ibu, category targets, planning and actual opening balances, funding transfers and recorded Activity stay isolated from breakdown edits/replacement. New-month creation retains the existing selected-plan copy behavior for non-item settings; paid flags, review confirmations and both opening-balance maps reset. Funding transfers continue to copy as before.

These are optional fields in version-1 budget documents; old documents remain accepted, with validation for new metadata/recurrence. No database migration or automatic October replacement is included. The pure `resetLaterBreakdowns` helper remains available for separately authorized maintenance, not app mount/navigation. Replacement is only through the confirmed user action.

Item add/edit/delete validation failures leave the dialog and draft available, show an actionable error, and do not save or partially mutate the plan. This includes valid legacy item lists exceeding generated forward-plan limits and planning revision overflow.

See [MONTHLY-BREAKDOWN-VERIFICATION.md](MONTHLY-BREAKDOWN-VERIFICATION.md) for exact evidence, limitations and release/rollback gates. This working tree is not published or deployed.

## Develop

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:5175/saldo-budget/` to test the same repository subpath as Pages. For local real OAuth testing, add that exact local callback URL to Supabase's allowed redirects. Never put secrets in configuration files.

```sh
npm test
npx playwright install chromium webkit
npm run test:ui
```

Browser integration tests explicitly use synthetic sessions and simulated Supabase HTTP responses; they exercise the real UI, Supabase JS SDK, and sync engine but do **not** prove your live OAuth settings. The database tests use real local PostgreSQL; see `DATABASE-VERIFICATION.md` for instructions and the isolation/concurrency checks performed.

Additional tracker checks: `/usr/bin/python3 tracker-db-test.py`, optional `/usr/bin/python3 tracker-http-test.py` (requires local PostgREST), and `deno check supabase/functions/shortcut-entry/index.ts`. See `TRACKER-DATABASE-VERIFICATION.md` and `TRACKER-HTTP-VERIFICATION.md` for the precise local test boundaries. No local test proves live OAuth or an installed iPhone Shortcut.

The public key can optionally be embedded into `config.mjs` for one-step end-user access; rebuild and upload `docs` afterward. Only a **publishable** key is allowed in a public frontend. The shipped default leaves it empty and asks each browser for it.

## Official references

- GitHub Pages publishing configuration: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- Supabase API keys: https://supabase.com/docs/guides/api/api-keys
- Supabase GitHub Auth: https://supabase.com/docs/guides/auth/social-login/auth-github
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security

Fonts are bundled with their OFL licenses. No analytics, ad scripts, CDN imports, OAuth provider-token collection, or automatic repository publishing are included.
