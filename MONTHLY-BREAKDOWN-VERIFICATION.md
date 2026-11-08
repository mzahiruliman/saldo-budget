# Five planning improvements — local verification

Branch: `feature/monthly-breakdown-carry-forward`, based on `b6de531cc037d8a966e0e60cbe8863d108a753a8`.

## Delivered scope

All five improvements are implemented in the local compiled app, not just the earlier scope selector:

1. Chronological recurring carry-forward, explicit month/onward add/edit/delete scope and persisted override boundaries.
2. Persisted carry source and own-change labels; legacy sources remain honestly unknown.
3. Optional month-local, nonmonetary month-start review checklist.
4. Recurring/One-off editing, display and inheritance; absent legacy recurrence means recurring.
5. Replacement source/target preview, consent/cancel and bounded, conflict-safe breakdown-only undo.

No push, merge, publication, deployment, production request, private-backup read or live-data replacement was performed. No automatic October reset or automatic migration is included. The parent's backup-first release gate remains in force.

## Model and persistence semantics

- New breakdowns use the greatest saved month strictly before the new month, across year boundaries. No predecessor means no items. Existing months are never replaced by navigation.
- Other new-month settings retain the previous selected-plan copy behavior. Paid flags, both opening-balance maps and checklist confirmations reset; funding transfers continue to copy as before.
- `updateMonthItems` is pure and validates input, edited definitions and generated output. Month-only edits preserve the previous recurring forward baseline, including for future months not yet created. Onward propagates recurring definitions until the first explicit boundary or different recurring snapshot; it never skips a boundary to modify a later matching snapshot.
- Definitions compare ID/order/name/amount/category/routes/credit/subscription/review/note/recurrence, ignoring paid and property order. Retained IDs preserve each target's paid flag; new IDs start unpaid. Local one-offs are not inherited and are preserved during ordinary propagation unless affected by the current source operation with the same ID; merely appearing in the source visible array does not supersede them.
- Optional version-1 `planning` metadata stores actual source (or null), own-change/boundary booleans, revision and optional unpaid recurring `forwardItems`. Explicit identical edits establish boundaries. Forward plans are limited to 1,000 items; malformed metadata, source references, amounts, recurrence and accounts are rejected. Legacy documents without these fields remain accepted.
- `reviewChecklist` accepts only four boolean confirmations; it is not inferred from money edits and changes no monetary/paid field.
- `previewLaterBreakdowns` lists exactly the later saved target months, source recurring definitions and before/after counts/totals. Source changes clear consent; no-target replacement stays disabled. Replacement overwrites target breakdowns, including target overrides and target one-offs, with unpaid recurring source items. Source/earlier months and unrelated fields stay unchanged.
- `replaceLaterBreakdowns` retains only items/planning before/after snapshots for undo, capped at 1.8 MB. Undo checks every target atomically against its post-replacement snapshot, including paid and planning revision, rejecting newer changes instead of rolling them back. It preserves newer salary, targets, balances, transfers and review confirmations. Only the latest replacement is retained in memory; reload/import/sign-out/loading another snapshot clears it. Export a private backup for durable recovery.
- The legacy pure `resetLaterBreakdowns` helper remains idempotent and validates generated output; it is never called on app mount/navigation. The UI uses the explicit previewed replacement API instead.
- Salary, Ibu, targets, balances, funding transfers and Activity remain isolated from breakdown edits. No ledger, tracker endpoint, database or migration files were modified.

## Verified results

Final logs under `verification/planning/`:

- `16-blocker-final-unit.log`: **86 passed, 0 failed, 0 skipped**.
- `17-blocker-final-build.log`: **build succeeded**, `docs/main.js` rebuilt from source.
- `18-blocker-final-browser.log`: **71 passed, 0 failed**, bounded to two workers, including Chromium and WebKit.
- `19-blocker-diff-check.log`: `git diff --check` clean.
- `20-blocker-artifact-manifest.log`: exact final commands, timestamps and SHA-256 hashes.

The older `06-final-unit.log` (75), `07-final-build.log`, `08-final-browser.log` (61) and `09-diff-check.log` are preserved historical evidence, superseded by the blocker-fix verification above.

The whole browser suite includes Activity/accounts/cloud/lifecycle regressions and **25 planning browser cases**. New controls were exercised against the actual compiled `docs` app and real Supabase JS SDK/sync engine using intercepted synthetic HTTP. No external backend was contacted by these fixtures.

Both Chromium and WebKit execute ordinary phone-sized touch-emulated clicks/fills/selects (390×844), without forced clicks, covering:

- Add/edit/delete onward propagation, monthly paid independence and first-override stopping.
- Truthful unknown-source, carried-source and own-change labels through save/reload.
- All four review confirmations, income editing not checking them automatically, retained paid state and unchecked new-month review.
- Recurring default, one-off addition, conversion to one-off, exclusion from inherited months and persisted month-only forward baseline.
- Exact source/affected-month preview, cancellation without mutation, consent reset on source change, no-target disabling, explicit replacement, preservation of unrelated fields, undo after newer income, and rejection after an identical explicit item edit.
- Reload persistence and session undo clearing. Additional Chromium tests cover import/Load latest undo invalidation and stale modal handler teardown, plus month-only add/edit/delete.

Screenshots are in `verification/monthly-breakdown/`: `phone-{chromium,webkit}.png`, `review-{chromium,webkit}.png`, `provenance-{chromium,webkit}.png`, `replacement-{chromium,webkit}.png`. The WebKit replacement preview was visually inspected: the modal remains within phone width, readable source/target list and consent/actions are visible without overlapping controls. This is browser emulation, not a physical iPhone/Safari test.

### RED/GREEN evidence and inherited partial work

This resumed task began with an expanded implementation and browser cases already in the working tree; it does not claim to have recreated their original TDD history. It inspected and executed those artifacts rather than relying on the outdated scope-1 report.

- `01-unit-red.log`: reproduced the current failure: reset accepted a generated 1,001-item forward plan.
- `02-unit-green.log`: full suite passed after adding generated-reset result validation (74 at that point).
- `03-build.log`, `04-browser.log`: compiled app and all 15 planning browser cases passed.
- `05-generated-revision-red.log`: new test demonstrated onward propagation returned invalid future metadata after safe-integer revision overflow.
- `06-final-unit.log`: generated-propagation validation fixed that issue; 75 tests passed.
- The earlier scope-1 TDD evidence remains in `verification/monthly-breakdown/`; it is not counted as coverage of the other four features.

Synthetic values only: no personal plan, real credentials, private backup contents or actual ledger records in fixtures/logs/screenshots.

## Independently reviewed release blocker — local repair

The prior independent review correctly failed the release gate despite 75 unit / 61 browser passes. No release is approved by these new local results; an independent re-review is still required before the parent's backup-first publication workflow.

**Root cause:** the UI sends the entire edited month's visible array to `updateMonthItems`. The model treated that array as an onward replacement, discarding the separately preserved forward baseline. Consequently, a month-only A edit/add/delete was silently promoted when a later, unrelated B edit/add/delete used onward scope. October A=900 (month-only), followed by October B=200 (onward), incorrectly produced November/new December A=900 instead of A=100. Filtering future local one-offs against every source ID could also remove an unrelated local one-off.

**Repair scope:** derive changed/added/removed definition IDs from pre-edit visible items (ignoring paid and normalized legacy recurring), apply only those operations to the existing recurring forward baseline, and propagate that resulting baseline only through matching inherited snapshots. Preserve unrelated definitions and target one-offs, monthly paid state, explicit boundaries and first-different-snapshot stopping. An identical explicit edit still increments provenance and creates a boundary. Recurrence conversions update only the current operation; new months inherit the persisted unpaid baseline after JSON reload. No other feature or backend was changed.

Item submit and deletion confirmation now catch model validation rejection before assigning state or calling save. They keep the modal, draft and scope controls usable, show an alert with backup/Load latest/planning-limit guidance, and do not issue a save request. Generated forward-plan overflow and maximum-revision fixtures exercise real model validation, not a mocked exception.

**Strict RED → GREEN logs in `verification/planning/`:**

- `10-sequential-scopes-red.log`: `node --test --test-name-pattern='isolates the forward delta' planning.test.mjs` — **all 9 failed**, demonstrating the full 3×3 sequence matrix before changing model code.
- `11-sequential-scopes-green.log`: `node --test planning.test.mjs monthly-breakdown.test.mjs` — **27 passed** after the operation-delta repair. Each matrix case checks source visible items, source forward baseline, an existing future snapshot, a new future month after JSON round-trip, paid flags, unrelated future one-offs and input immutability.
- `12-error-handling-red-build.log`: successful build of the model repair with the still-unhandled item UI.
- `13-item-errors-red.log`: Chromium + WebKit add/edit/delete maximum-future-revision cases — **all 6 failed** before UI exception handling; error feedback was empty/missing.
- `14-item-errors-green-build.log`, `15-item-errors-green.log`: rebuilt UI and **all 6 passed**. They assert no uncaught page errors, zero save requests and unchanged saved payload on rejection, retained draft, and a successful month-only retry that leaves the overflowing future month unchanged.
- Final supporting coverage adds two model edge cases (unrelated same-ID one-off preservation with recurrence conversion; persisted identical future boundary), plus Chromium/WebKit oversized legacy-plan rejection and the exact A/B sequential edit through real UI save/reload/new-month creation. These reuse the already RED-proven behaviors; no additional implementation was required.
- `16-blocker-final-unit.log`, `17-blocker-final-build.log`, `18-blocker-final-browser.log`, `19-blocker-diff-check.log` and `20-blocker-artifact-manifest.log` contain final verification and artifact identity. Final total: **86 unit, 71 browser (25 planning)**, no failed/skipped tests.

Browser error RED/GREEN commands use the environment below and `npm run test:ui -- monthly-breakdown.spec.cjs --grep 'validation failure stays' --workers=2`. Final browser verification runs the whole suite, not only planning.

## Browser environment and reproduction

Browsers and missing host libraries had already been recovered user-locally in the earlier task, without sudo/system package changes. The cached WebKit launcher appends the caller's library path. Scratch dependencies can be pruned and are not part of the app deliverable. On a normal host, install Playwright's browser dependencies normally. Exact passing command on this host:

```sh
npm test
npm run build
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
LIBGL_ALWAYS_SOFTWARE=1 \
__EGL_VENDOR_LIBRARY_FILENAMES=/home/biskut/.hermes/cache/scratch/saldo-browser-libs/extracted/usr/share/glvnd/egl_vendor.d/50_mesa.json \
LD_LIBRARY_PATH=/home/biskut/.hermes/cache/scratch/saldo-browser-libs/extracted/usr/lib/x86_64-linux-gnu \
GST_PLUGIN_PATH=/home/biskut/.hermes/cache/scratch/saldo-browser-libs/extracted/usr/lib/x86_64-linux-gnu/gstreamer-1.0 \
npm run test:ui -- --workers=2
```

The host-dependency validator is skipped because it does not recognize all user-local libraries; the actual browsers launched and ran all tests. This does not skip browser cases.

## Limitations and release/rollback gate

- This is a verified local working tree, not a deployed release. Real OAuth, production persistence, multiple physical devices and installed iPhone behavior were not tested here. No database/endpoint changes are needed or claimed.
- Provenance cannot be reconstructed for old snapshots. Legacy equality still cannot distinguish an intentionally identical override until an explicit edit establishes a boundary. Month-only forward baselines and boundaries now persist for new edits.
- Undo is session-only, bounded and deliberately conservative. A paid edit also blocks undo; use authorized field-scoped reconciliation rather than restoring a whole old plan over newer work.
- Existing cloud revision/size checks still apply: saved status is truthful only after acknowledgement. A local undo operation is not a server-side historical restore or ledger rollback.
- Before rollout, independently review, preserve the current deployed code/assets and latest private plan, and obtain explicit release approval. Do not re-run a prior October replacement just because the frontend changed.
- Frontend rollback does not undo already saved edits. Older code may accept optional fields but does not implement their recurrence/boundary semantics; avoid further planning edits with an old frontend until reviewed. Any data repair needs separately authorized reconciliation against the latest revision. Activity must never be restored by this feature.
