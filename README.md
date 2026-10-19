# Saldo · private cloud budget

Responsive monthly budget planner for GitHub Pages + Supabase Auth/Postgres. This repository intentionally contains **no personal starter budget**. Your real data belongs in the authenticated database and private JSON backups, never in the repository.

## Current delivery status

The app and database migration are provided for deployment. Local automated tests are separate from a successful live Supabase/GitHub OAuth deployment. No cloud account credentials are included. Nothing in this package automatically publishes a site or changes a live database.

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
- This version loads on sign-in/open and with **Load latest**; it is not continuous realtime co-editing. Keep one editor active at a time when possible.
- Signing out clears the displayed budget. Discarding an unsaved draft to sign out requires confirmation; export first. Cloud records remain intact.
- Keep periodic JSON backups, especially before migration or replacing the app. The original portable edition stays independent and is not changed by this deployment.

## Security model

GitHub Pages publishes static code, not private budgets. Supabase identifies signed-in users. Row Level Security allows users to read only their own document. Writes go through a restricted database function that derives the owner from `auth.uid()` and atomically checks the expected revision. Browser code contains no privileged backend credentials. Other signed-in users receive separate blank budgets; this is data isolation, not a single-user allowlist. Restrict account creation separately if you do not want additional users consuming project quota.

The client validates imported/cloud state; the save function enforces authentication, object shape, size, and concurrency rather than validating every budgeting field. A user can only modify their own data. No bank connection or payment execution is provided.

## Develop

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:5174/saldo-budget/` to test the same repository subpath as Pages. For local real OAuth testing, add that exact local callback URL to Supabase's allowed redirects. Never put secrets in configuration files.

```sh
npm test
npx playwright install chromium
npm run test:ui
```

Browser integration tests explicitly use synthetic sessions and simulated Supabase HTTP responses; they exercise the real UI, Supabase JS SDK, and sync engine but do **not** prove your live OAuth settings. The database tests use real local PostgreSQL; see `DATABASE-VERIFICATION.md` for instructions and the isolation/concurrency checks performed.

The public key can optionally be embedded into `config.mjs` for one-step end-user access; rebuild and upload `docs` afterward. Only a **publishable** key is allowed in a public frontend. The shipped default leaves it empty and asks each browser for it.

## Official references

- GitHub Pages publishing configuration: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- Supabase API keys: https://supabase.com/docs/guides/api/api-keys
- Supabase GitHub Auth: https://supabase.com/docs/guides/auth/social-login/auth-github
- Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security

Fonts are bundled with their OFL licenses. No analytics, ad scripts, CDN imports, OAuth provider-token collection, or automatic repository publishing are included.
