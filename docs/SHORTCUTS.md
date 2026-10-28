# Saldo → iPhone Shortcuts (manual build guide)

## Delivery and deployment boundary

This is a **manual iPhone build guide**, not a signed `.shortcut` file, installed shortcut, or verified physical-iPhone workflow. The request handler has local Node Web API tests with explicit fetch-boundary fakes; these do not prove a live database commit. Nothing in this change deploys the function, applies SQL, publishes the app, or calls the real project.

Proposed endpoint (use only after the owner approves and completes deployment):

```text
https://cxezfmlzvyodmjxtjtzb.supabase.co/functions/v1/shortcut-entry
```

Before phone setup, the owner must apply the reviewed tracker/capability migration, publish the reviewed pairing UI, and configure this Edge Function with **platform JWT verification disabled for this function only**. A device capability is not a Supabase user JWT. The handler still requires its own credential and calls the capability RPC for every GET/POST. This is not an unauthenticated write endpoint. Future platform configuration, not a deployment performed here:

```toml
[functions.shortcut-entry]
verify_jwt = false
```

Server configuration:

- `SUPABASE_URL`: HTTPS project origin, no path/query/userinfo.
- `SUPABASE_PUBLISHABLE_KEYS`: JSON object; choose its nonempty `default` string, otherwise its first nonempty string value. An array of strings also works.
- `SB_PUBLISHABLE_KEY`: optional public-key fallback, useful for local tests.
- `SUPABASE_ANON_KEY`: legacy **public anon** JWT fallback only.
- Never configure or use a privileged project credential. The adapter rejects unrecognized key classes and JWTs whose role is not `anon`. It sends the project public key only in `apikey`, never as an invented Bearer JWT.

## 1. Pair once, privately

1. Sign in to your Saldo account. In the Activity/Shortcuts pairing controls, create a device credential for this iPhone, selecting the intended time zone and expiry. Exact button labels may change; pair through the signed-in UI, not a token in a URL.
2. Copy the credential once into the shortcut's private configuration on your own phone. Its shape is `sld_` followed by 43 base64url characters. This is **not** your project publishable key, password, or normal user session JWT.
3. Keep it out of chat, screenshots, logs, shared files, and shared/exported shortcuts. A Text action is convenient, **not a secure vault**: anyone who can edit the shortcut can read it, and shortcut/iCloud sync may copy it. Do not share the configured shortcut. Use a trusted local credential-storage integration if your threat model requires one; none is installed by this guide.
4. Revoke the device from Saldo if the phone/shortcut is lost or exposed; pair again after expiry or revocation. Never paste the credential into support chat for troubleshooting.

## 2. Fetch account choices at each new entry

Create a shortcut named “Record in Saldo”. Add **URL**, then **Get Contents of URL** with Method **GET**. Use the endpoint above (optionally append `?action=metadata`). In its expanded headers add:

```text
Authorization: Bearer <your-private-paired-device-credential>
```

No token in query parameters, path, or request body. Do not add `user_id` or an owner value. No `Origin` header is needed for native Shortcuts. Requests from browsers are restricted to `https://mzahiruliman.github.io`, `http://localhost:5174`, and `http://127.0.0.1:5174`; CORS is not credential validation.

Use the JSON dictionary result. On success it has:

```json
{"accounts":[{"id":"account-id-from-Saldo","name":"Account display name","type":"bank"}],"categories":["commitment","entertainment","savings"],"time_zone":"Asia/Kuala_Lumpur"}
```

This is a schema illustration, not a fetched account or user data. Validate that `accounts` and `categories` are lists and `time_zone` is text; stop on an `error` key, missing fields, or a Shortcuts networking error.

Use **Repeat with Each**, **Get Dictionary Value**, **List**, and **Choose from List** to build account choices. Each visible choice should contain both `name` and `id` (for example `Name · account-id`), retaining a mapping back to that account dictionary. Extract its **id** into the payload; do not send a name, list index, or an arbitrary bank label as an account ID. Names can repeat or change. Choices must come from this owner's freshly fetched list, not a universal hardcoded bank list.

## 3. Collect and confirm the entry

Use **Choose from List** for Income / Expense / Transfer; map these labels to lowercase `income`, `expense`, `transfer`.

| Type | `from_account_id` | `to_account_id` | Other fields |
| --- | --- | --- | --- |
| Income | Omit | Your chosen own account ID, or omit for Unassigned | Free-text `external_party` describes who paid you. |
| Expense | Your chosen own account ID, or omit for Unassigned | Omit | Free-text `external_party` describes who you paid; optional expense category from metadata. |
| Transfer | A chosen own account ID | A **different** chosen own account ID | Omit external party and category. Both accounts required; no Unassigned. |

“Unassigned” means omit that account field (or send JSON `null`), **not** the string `unassigned`, an empty string, or a made-up account ID. An external party is free text, not another owner's account. Keep payer/payee separate from your own account selection.

1. Add **Ask for Input**, input type **Number**, asking for the amount in MYR. Require a positive value with at most two decimal places. Use **Calculate** to multiply by 100, **Round Number** to zero decimal places, and compare the round-trip cents/100 with the original amount to reject extra precision. Check the final cents is a positive integer (1 through 10000000000); no zero, negative, fractional cents, currency symbols, or formatted comma strings. Review the displayed amount before saving; do not silently round a value the user did not confirm.
2. Income/expense: choose the appropriate own-account list plus Unassigned. Ask for an optional external-party text (maximum 160 characters). Transfer: choose both own accounts and stop if their IDs match.
3. Expense only: offer the category IDs from metadata plus “No category”. Map display labels back to their metadata value. Omit `category` for no selection and all income/transfer entries.
4. Optional **Ask for Input** text for `note` (maximum 500 characters); omit when blank.
5. Capture the occurrence date/time using **Date** and **Format Date**. Use ISO 8601 with seconds and an explicit offset, for example `2026-10-27T09:30:00+08:00`. A custom date format `yyyy-MM-dd'T'HH:mm:ssXXX` expresses this; inspect the output on your iPhone and ensure it includes an offset or `Z`, never just a localized display date. Capture once, not again on retry.
6. Show a confirmation with type, amount, source/destination labels, external party, category, note, and timestamp. Only after confirmation generate **one** `request_id` UUID for this entry; keep that UUID and all payload fields unchanged on retry.
7. Do **not** supply `source`, `user_id`, or any owner field. The database selects the paired owner and sets `source='shortcut'`; ordinary signed-in app recording sets `source='app'`. Neither value is accepted on trust from a caller. The paired credential supplies the database time zone, so this shortcut need not send `time_zone`. Metadata exposes it so you can display the configured zone.

### UUID without assuming an unverified “Generate UUID” action

Apple's guide does not establish a built-in action with that name. You can construct a UUIDv4 with documented list/repeat actions instead:

- Define a helper group `Hex(N)`: **Repeat** N times; inside, **List** with separate items `0,1,2,3,4,5,6,7,8,9,a,b,c,d,e,f`, then **Get Item from List → Random Item**. After End Repeat, **Combine Text** with a custom empty separator. Retain its output as a variable. Duplicate the helper group for each required length.
- Separately choose Random Item from a List containing `8,9,a,b`, retaining it as `V`.
- Use **Text** with variable substitutions and literal hyphens to assemble `Hex(8)-Hex(4)-4Hex(3)-VHex(3)-Hex(12)`. For example, the third group is a literal `4` immediately followed by its three random hex characters, without spaces.
- This is an idempotency identifier, not a replacement for the securely issued device credential. Run this construction once per newly confirmed entry, never in the network retry branch.

## 4. POST typed JSON and require acknowledgment

Use a second **Get Contents of URL** action, same URL, Method **POST**; expand it and set:

```text
Authorization: Bearer <your-private-paired-device-credential>
Content-Type: application/json
```

Choose Request Body **JSON**, with typed fields/variables, not a hand-concatenated string containing unescaped user text. `amount_cents` must be a Number, not Text. Example schema for an unassigned expense (identifiers and figures below are illustrative only):

```json
{
  "request_id": "c276c28b-b029-4c81-8ec6-7285381f572a",
  "type": "expense",
  "amount_cents": 125,
  "occurred_at": "2026-10-27T09:30:00+08:00",
  "external_party": "Example shop",
  "category": "entertainment",
  "note": "Optional note"
}
```

Add `from_account_id` for an assigned expense, `to_account_id` for assigned income, or both distinct IDs for transfer. Omit irrelevant fields. Total UTF-8 JSON body must fit within 8192 bytes, including keys and multibyte text.

**Never put “Saved” immediately after the network action.** The HTTP contract is:

- **200** plus an object `{ "transaction": { "id": "...", ... }, "duplicate": false }`: database RPC has returned a committed transaction acknowledgment.
- **200** and `duplicate: true`: same confirmed entry was already recorded; treat as acknowledged, not a second transaction.
- **401**: malformed, expired, revoked, or otherwise unauthorized device; stop and pair/review in Saldo.
- **429**, `Retry-After: 60`: keep the same payload and UUID; manually retry after at least 60 seconds.
- **409**: account changed or UUID reused with different payload; stop and review. Refresh metadata for account changes. Do not automatically mint a new UUID after an ambiguous save.
- **400**: invalid entry/query. **413**: oversized body. **415**: JSON content type required. **403**: browser origin rejected. **405**: unsupported method.
- **502/503**, timeout, parse error, missing transaction ID, or missing/non-Boolean duplicate: no positive acknowledgment. Preserve the entry and retry safely; a timeout can occur after a commit.

**Status-code limitation:** Apple's documented native Get Contents of URL action does not promise a separate numeric HTTP-status output. Do not invent a “Get POST Status” action or use a separate HEAD request as proof of the POST result. If your installed HTTP action exposes the actual POST response status, explicitly require **200** before inspecting the acknowledgment. With the native-only workflow, stop on action errors and JSON `error`; use **Get Dictionary Value** and **If** to require a nonempty `transaction.id`, matching `transaction.request_id` to your pending UUID, and a Boolean `duplicate` before showing success. If you need independently inspectable numeric status on iPhone, use a trusted HTTP-client action that exposes it and validate that action on-device; no third-party app is installed or verified here. The optional curl check below exposes the actual status for manual verification.

## 5. Optional manual private outbox (not an automatic offline worker)

A failed network action can stop Shortcuts before subsequent actions run. To preserve a confirmed entry, put its final JSON in a file **before** attempting POST:

1. Use **Save File** with the final JSON text and a filename `<request_id>.json`; select a private folder such as `On My iPhone/Shortcuts/SaldoPending` in Files, **if that location is offered on your device**. Create/select the folder manually. If you choose iCloud Drive/Shortcuts instead, those files may sync; that is not a local-only outbox.
2. Store only the payload, not the credential or Authorization header. These files still contain sensitive transaction descriptions; do not share the folder, expose it to public sync, or use real budget data for initial tests.
3. POST that same frozen payload. After the validated acknowledgment, manually remove/archive its pending file (or add a file-removal action only within the successful-acknowledgment branch).
4. To retry, manually select the saved JSON file in Files/Shortcuts, read it as a dictionary, preview it, and POST the same fields with the same UUID, timestamp, amount, and account IDs. Do not re-run the new-entry prompts or UUID/date-generation steps. Keep its file until acknowledged.
5. If you correct a rejected entry, explicitly review whether the previous request could have committed. The same UUID with changed payload intentionally returns 409. Check Saldo first when a network failure left the outcome unknown; a truly new confirmed entry needs a new UUID.

This guide does not install background retries, guarantee offline execution, or claim the pending-file helper has been tested on iPhone. Initial entry metadata requires a network connection. The file method preserves a payload already confirmed while metadata was available; it does not enable brand-new offline account selection automatically.

## Optional owner-run curl check after approved deployment

**Not run by this implementation.** These placeholders are not valid credentials. Run locally on your own trusted terminal; avoid shell history containing a real token and unset it afterward. The phone-facing endpoint needs the paired **device** credential, not a project key. A server/local-test public key placeholder is `sb_publishable_REPLACE_WITH_PUBLIC_PROJECT_KEY`; do not put that in the device Bearer header.

```sh
ENDPOINT='https://cxezfmlzvyodmjxtjtzb.supabase.co/functions/v1/shortcut-entry'
DEVICE_TOKEN='REPLACE_WITH_PRIVATE_PAIRED_DEVICE_CREDENTIAL'
curl --silent --show-error --include "$ENDPOINT" \
  --header "Authorization: Bearer $DEVICE_TOKEN"
# For an explicitly approved test entry only; entry.json is your reviewed payload:
curl --silent --show-error --include "$ENDPOINT" \
  --request POST \
  --header "Authorization: Bearer $DEVICE_TOKEN" \
  --header 'Content-Type: application/json' \
  --data-binary @entry.json
unset DEVICE_TOKEN
```

Inspect the returned HTTP status and JSON. Repeating that exact reviewed JSON should return the same transaction ID with `duplicate: true`, not create another entry. These commands can create a real transaction; do not run them until deployment and the test entry are approved.

## Adapter security and local verification

`index.ts` imports `./handler.mjs` and serves `createHandler({url,key})`. The injectable `fetch` is the HTTP boundary, not an alternate database implementation. Each incoming GET/POST requires `Authorization: Bearer sld_<43 base64url characters>`. Only `action=metadata` on GET is an accepted query; token queries and supplied identity/source fields are rejected. OPTIONS is a credential-free, bodyless 204 for allowed/no origins. Disallowed origins receive 403 without CORS permission.

The adapter sends HTTPS POST JSON to `/rest/v1/rpc/shortcut_metadata` (`p_token`) or `/rest/v1/rpc/shortcut_record` (`p_token`, `p_entry`). It disables redirects, aborts fetch after ten seconds, bounds incoming streamed bytes even without Content-Length, and returns fixed safe errors instead of database details/SQL/keys/tokens. It does not log bodies or credentials. Capability hashing, owner, expiry, scope, rate limits, account ownership, canonical idempotency, payload validation, and transaction commit are the **database RPC's responsibility**. A public project key alone grants no device authority.

Run from the repository root:

```sh
node --test edge-shortcut.test.mjs
deno check --config supabase/functions/shortcut-entry/deno.json supabase/functions/shortcut-entry/index.ts
```

Tests use only synthetic credentials/entries and fake upstream fetch responses, including metadata, duplicate/new acknowledgments, malformed ACKs, error mappings, auth/query/CORS/config restrictions, byte bounds, and a real ten-second abort wait. They make no live Supabase request. Database integration and a real iPhone walkthrough remain separate deployment-approval/on-device acceptance steps.

### Official references consulted

Action names can vary with iOS version/localization. Apple's documentation establishes Get Contents of URL (GET/POST/JSON), Ask for Input (Number), list selection/random items, repeat output, date formatting, and Save File. It does not establish native numeric POST-status output or a built-in UUID action in the material consulted.

- Apple, Request your first API: `https://support.apple.com/guide/shortcuts/get-contents-of-url-apd58d46713f/ios`
- Apple, Ask for Input: `https://support.apple.com/guide/shortcuts/use-the-ask-for-input-action-apd68b5c9161/ios`
- Apple, Use list actions: `https://support.apple.com/guide/shortcuts/use-list-actions-apd4dcacc115/ios`
- Apple, Use Repeat actions: `https://support.apple.com/guide/shortcuts/use-repeat-actions-apdc11deb2c1/ios`
- Apple, Technical standards / ISO 8601: `https://support.apple.com/guide/shortcuts/technical-standards-apdfd459e13d/ios`
- Apple, Format Date: `https://support.apple.com/guide/shortcuts/apdfb33b0e17/6.0/ios/16.0`
- Apple, Transform actions / Combine Text: `https://support.apple.com/guide/shortcuts/apd1d9413cfb/5.0/ios/15.0`
- Apple, Share actions / Save File: `https://support.apple.com/guide/shortcuts/share-actions-apdaf74d75a5/ios`
- Supabase, Authorization headers / platform JWT check: `https://supabase.com/docs/guides/functions/auth-headers`
- Supabase, Securing Edge Functions: `https://supabase.com/docs/guides/functions/auth`
