# Activity alignment fix — local verification

## Reproduction and root cause

The user reported mobile heading/month overlap and uneven desktop native form-control heights. The full compiled app reproduced the issue: generic `header` rules in style.css imposed the shell toolbar's fixed height/padding on Activity's nested semantic header. Earlier component-only tests omitted the global stylesheet, and horizontal-overflow checks did not detect vertical overlap.

Ten new layout cases (five widths each in Chromium and WebKit) first failed on heading containment. After isolating shell styles, they exposed undersized/inconsistent native controls. A further assertion reproduced the empty metadata container reserving a blank grid row.

## Changes

- Scope all three shell header rules to `.app > main > header`.
- Give Activity its own auto-sized, responsive heading/action layout.
- Keep heading, descriptions, status, month and cards from overlapping; hide an empty metadata slot while retaining an error/loading row.
- Normalize Activity input/select heights to 48px and remove native select appearance while preserving the semantic select/picker and providing a chevron.
- Rebuild the two affected deployment CSS files. No application JavaScript, database, account or budget changes.

## Actual checks

- `npm run build`: passed.
- `npm test`: 54 passed.
- `npm run test:ui`: 42 passed with bounded two-worker concurrency.
- New matrix: Chromium and WebKit at 375, 393, 430, 768 and 1440 CSS pixels. Checks cover heading containment, month separation, empty-row spacing, aligned 48px controls, mobile stacking and no horizontal overflow.
- Original 32 browser regressions remain in the full run. The first default-five-worker run hit the existing cross-client test's 15-second whole-test deadline; the two-worker rerun passed all tests without increasing timeouts or relaxing assertions.
- `git diff --check`: passed.

These are synthetic session/HTTP fixtures with the real compiled UI, bundled fonts and full global/cloud/Activity CSS, not real-account or physical-iPhone execution. WebKit is a local browser-engine check, not a claim of testing the user's installed Safari.

## Release boundary

The currently deployed source at 86a9f2b254cfacda214d753d3c2d221f898b41ab was archived before changes. This fix is prepared on a feature branch. Production publication remains approval-gated; no live database/function changes are needed.
