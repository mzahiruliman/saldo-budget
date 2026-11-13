# Monthly breakdown sorting — local verification

## Scope

- Local branch: `feat/monthly-breakdown-sorting`, based on `e095a5c5a98467de832a060cab335048f2b5b77f` (matched fetched origin/main at start).
- Monthly breakdown toolbar: Original order, Name A–Z / Z–A, Amount low to high / high to low.
- Name comparison is English, case-insensitive and natural-numeric. Equal keys keep original order. Amount comparison uses integer cents, not formatted text.
- Sorting applies to the filtered display array, never the saved item array. It makes no save request. No model, database, migration or Activity change.
- Choice stays during category changes, search, item saves, view navigation and month navigation in the current mounted budget session. Reload starts at Original order. No persistent preference is claimed.
- Generated `docs/main.js` and `docs/style.css` rebuilt. No remote publication or deployment performed.

## Executed checks

- RED: Chromium browser test failed because the Sort monthly breakdown control was absent. After name implementation, name sorting test passed.
- RED: amount sorting test could not select absent amount options. After implementation, both numeric directions passed.
- `npm run build`: passed.
- `npm test`: 86 passed, 0 failed.
- `npm run test:ui`: 75 passed, 0 failed, including four new sorting cases (name and amount in Chromium and WebKit).
- Sorting cases use the compiled docs app with synthetic intercepted cloud HTTP. They test case-insensitive names, both directions, numeric amounts including zero and ties, original-order restoration, filters/search/no matches, no sorting writes or saved-document changes, paid/edit/add identity, retained sorting through rerenders/months, reload reset, mobile width and desktop interaction.
- Inspected `verification/monthly-breakdown/sorting-webkit.png`: sort and search controls fit phone width without overlap; row amount/edit controls visible. No physical iPhone test.

## Browser runner environment

Host browsers initially lacked shared libraries. No sudo access. Downloaded distribution packages using `apt-get download` and extracted them under `/home/biskut/.hermes/cache/scratch/saldo-browser-deps/extracted`, without global installation. Chromium launched with the local library path. WebKit launched and passed actual interactions with local Mesa/software rendering. Host validation was bypassed only after libraries were supplied; test results are real browser execution, not dependency probes.

Re-run browser tests while scratch libraries exist:

```sh
LD_LIBRARY_PATH=/home/biskut/.hermes/cache/scratch/saldo-browser-deps/extracted/usr/lib/x86_64-linux-gnu \
__EGL_VENDOR_LIBRARY_FILENAMES=/home/biskut/.hermes/cache/scratch/saldo-browser-deps/extracted/usr/share/glvnd/egl_vendor.d/50_mesa.json \
LIBGL_DRIVERS_PATH=/home/biskut/.hermes/cache/scratch/saldo-browser-deps/extracted/usr/lib/x86_64-linux-gnu/dri \
LIBGL_ALWAYS_SOFTWARE=1 PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 npm run test:ui
```

Full execution logs: `/home/biskut/.hermes/cache/scratch/saldo-sort-unit-tests.log` and `/home/biskut/.hermes/cache/scratch/saldo-sort-ui-tests.log` (temporary).

## Independent review

Read-only independent reviewer passed with no security concerns or logic errors. Reviewer checked display-only sorting, ID-based paid/edit handlers, filter/search compatibility, responsive styles, added-line security scan and syntax/whitespace checks. An independent in-memory build matched `docs/main.js` exactly and shipped CSS matched source. Physical-phone native-picker verification remains optional and unperformed.

## Recovery and release boundary

Verified archive of pre-change tracked source/assets: `/home/biskut/backups/saldo-budget/before-monthly-sorting-e095a5c.tar.gz` (78 archive entries). This is a code/build backup, not a saved-plan, transaction, authentication or Storage backup. No production data was read or written. A future live rollout still requires approval and the existing backup-first release gate. Restoring frontend files does not undo budget edits or recorded transactions.
