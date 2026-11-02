# Accounts: plan versus actual — verification

Scope: read-only actual figures alongside unchanged plan projections on **Accounts & routes**. No database migration, no change to `public.transactions`, `public.budget_documents`, Edge Functions, RLS or RPCs.

## Behaviour added

- Per-account **plan projection** remains exactly the existing calculation from `openingBalances`, salary, budget routes and planned funding transfers.
- Per-account **recorded movement** comes from `tracker_summary.movements` for the selected month.
- **Tracked balance** = actual opening balance at the start of that month + recorded movement.
- Actual opening balances are optional, signed integer cents, dated `YYYY-MM-01`, validated against the account registry, and reset when a new month is created. Documents without the optional field remain valid.
- Recorded activity failure is shown honestly and can be retried. Own-account transfers count as movement, not income/expense. Removed-account movements and unassigned totals remain visible rather than silently disappearing.
- Realtime transaction changes refresh only the Accounts actuals view; they do not reload the plan. A manual **Refresh recorded activity** control is available.

## Local evidence

- `npm test`: **57 passed, 0 failed**.
  - Model validation for signed actual balances, first-of-month dates, unknown accounts, invalid dates and new-month reset.
  - Tracker summary rejects a missing movements payload, non-object movements, non-integer movement values and malformed optional totals.
- `npx playwright test`: **46 passed, 0 failed**.
  - New `account-actuals.spec.cjs`: recorded movement, tracked balance, unchanged projection, signed actual balance editing, month-start date, percentage/plan field preservation, unassigned income/expense netting, summary failure + retry, and wrong-month actual-balance review.
  - Compiled-app `tracker-integration.spec.cjs`: real Supabase JS SDK path fetches `tracker_summary` and renders the account movement while plan writes remain `0`.
  - Existing planner, lifecycle, recovery, cloud, Activity and layout checks remain green.
- Phone-width compiled page: no horizontal overflow; screenshot inspected for clipping/overlap.

These are local browser/unit checks against synthetic HTTP and module fixtures. They do **not** prove the live GitHub Pages deployment, live Supabase project, native OAuth session or a physical iPhone Shortcut run.

## Deployment boundary

Backup captured before edits at `/workspace/project/Saldo-backups/pre-account-actuals-20261102T122538Z/` (live assets, hashes, and source archive of deployed `main`). This change is frontend/private-document only; no database migration is required.
