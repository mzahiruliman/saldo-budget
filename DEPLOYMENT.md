# Deployment checklist — Saldo cloud edition

> **Existing installation adding Activity/Shortcuts:** use [TRACKER-DEPLOYMENT.md](TRACKER-DEPLOYMENT.md). The checklist below is for the original cloud setup, not an instruction to replace your live plan. The new feature remains release-gated.

Keep the original portable Saldo and its latest exported backup until the cloud version is confirmed working.

## 1. Create the private database storage

Open the existing Supabase project dashboard. In **SQL Editor**, choose a new query, paste the complete contents of `database.sql`, and run it. Expected: successful execution, with `budget_documents` appearing under public tables. Do not run `database-test.py` or its synthetic auth fixtures in your live project.

## 2. Upload the prepared repository files

Extract the release ZIP. Upload the **contents** of its `saldo-budget` folder into your existing repository, preserving the `docs` subfolder. Your private JSON backup, original PDF, and old personal-seeded HTML are not part of this release and must not be added.

## 3. Enable the correct publishing folder

GitHub repository → **Settings → Pages**:

- Source: **Deploy from a branch**
- Branch: **main**
- Folder: **/docs** (not root)

Save, then wait for the Pages deployment to finish. The project URL is:

`https://mzahiruliman.github.io/saldo-budget/`

This cloud edition uses a prebuilt `docs` folder. You do not need to install Node.js just to upload those files.

## 4. Verify authentication settings

Supabase → Authentication → URL Configuration:

- Site URL: `https://mzahiruliman.github.io/saldo-budget/`
- Allowed redirect URL: `https://mzahiruliman.github.io/saldo-budget/`

In the GitHub OAuth application's settings, the authorization callback must instead be the callback shown by Supabase's GitHub provider. Keep Client Secret in Supabase only.

## 5. Connect the app and restore your budget

1. Open the Pages address.
2. If prompted, paste the **publishable key** (`sb_publishable_…`) from Supabase Project Settings → API Keys into the **app's connection screen**. Do not send it through chat. This public configuration is saved only in that browser; repeat once on another device unless you choose to embed the publishable key in a rebuilt frontend later.
3. Select **Continue with GitHub**.
4. Open **Plan settings → Import backup**, select the latest private JSON backup from your old app, and confirm replacement.
5. Wait for **Saved to cloud**. A local draft or visible dashboard is not sufficient proof of a successful cloud save.
6. Open the site on your phone, connect and sign into the same GitHub account, and verify your budget appears.
7. Make a small edit on the phone. On the Mac, choose **Load latest** and confirm it appears. If there is a conflict, export the local draft before choosing to discard it.

## Troubleshooting

- Blank app: check that Pages publishes **main /docs** and that the full docs folder was uploaded.
- Missing table/function: verify the database SQL was run successfully.
- Redirect/sign-in error: verify both Supabase URL Configuration and the separate GitHub OAuth callback.
- Network failure: check connectivity and whether the Supabase project needs resuming. Do not disable Row Level Security.
- Cloud conflict: the app deliberately refuses to overwrite a newer revision. Export the draft, load the latest budget, and reapply the wanted edits.

No remote deployment, live SQL execution, real OAuth authorization, or import of your latest personal data has been performed by the code-delivery process. The final live checks require your account access and backup.
