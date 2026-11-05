---
name: privacy-compliance
description: Build a Play-ready privacy policy, Data safety inventory, consent/disclosure flows, account-deletion flow, and evidence that declarations match actual collection and sharing; includes a PII-in-logs scan
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  platform: android
---
## What I do
- Inventory data collection from app code, SDKs, backend/API flows, on-device storage, and developer declarations.
- Generate a privacy-policy draft and a Data safety inventory from checked-in templates.
- Decide which consent and disclosure flows apply, instead of applying every flow to every app.
- Add an in-app and web account-deletion path when the app enables account creation.
- Scan source for PII written to logs and for declaration mismatches.

## When to use me
- Before a Play release, or when adding an SDK, permission, backend endpoint, account feature, ads, analytics, or crash reporting.
- When the Play Data safety form, privacy policy, or account-deletion requirement is being completed.
- When reviewing whether a privacy declaration matches what the app actually collects or shares.

## Workflow

### 1. Scan the project
Run the `privacy_scan` MCP tool with the Android project root:

```json
{
  "projectPath": "/absolute/path/to/app",
  "reportPath": "/absolute/path/to/app/privacy/privacy-scan.md",
  "strict": false
}
```

The report lists:
- manifest permissions;
- known privacy-relevant SDK artifacts;
- network endpoints observed in source and network-security configuration;
- on-device storage markers;
- account creation/deletion markers;
- log calls that reference PII identifiers;
- differences from `privacy/data-safety.json`.

A static scan is evidence, not proof. It cannot see backend payloads or runtime behavior. Use `net_capture` and `adb_logcat` when behavior matters.

### 2. Build the inventory
Copy `templates/data-safety-inventory.md` to `privacy/data-safety-inventory.md` and fill it from:
- app code and manifest permissions;
- Gradle dependencies and SDK documentation;
- backend/API request and response models, including endpoints not in this repository;
- on-device storage (Room, DataStore, SharedPreferences, files);
- developer declarations and the current Play Console answers.

Do not fill the inventory from permissions and SDKs alone. For every row, record the evidence path or the person/document that confirmed it.

### 3. Write the machine-readable declarations
Copy `templates/data-safety.json` to `privacy/data-safety.json` and replace every value with the app's real declarations:

```json
{
  "permissions": ["INTERNET", "CAMERA"],
  "sdks": ["com.google.firebase:firebase-analytics"],
  "endpoints": ["api.example.com"],
  "accountCreation": true,
  "accountDeletion": true
}
```

Then rerun `privacy_scan`. Treat these results as blockers until reviewed:
- observed permission, SDK, or endpoint missing from declarations;
- account creation observed but declarations say it is disabled;
- account deletion observed but declarations say it is disabled.

Treat stale declarations (declared but not observed) as review items: they may come from manifest merging, a transitive dependency, or a backend-only flow.

### 4. Draft the privacy policy
Copy `templates/privacy-policy.md`, replace every placeholder, and have the resulting policy reviewed by the responsible legal/privacy owner. Host it at a public, stable URL and link it from the app and the Play listing.

The policy must describe the actual practices in the inventory, including SDK and backend sharing. Do not publish a generic template unchanged.

### 5. Select consent and disclosure flows
Use `templates/consent-and-account-deletion.md` to decide what applies. At minimum:
- request runtime permissions in context, immediately before the feature needs them;
- disclose analytics, ads, crash reporting, and third-party SDK collection in the policy and Data safety form;
- provide any legally required consent before collection for the target jurisdictions and user ages;
- keep a denial path that leaves the rest of the app usable where the feature is optional.

Consent and disclosure requirements depend on the data, the audience, and applicable law. This skill does not replace legal review.

### 6. Add account deletion when accounts exist
If the app lets users create an account:
- provide an in-app path that starts deletion;
- provide a public web URL for deletion requests;
- delete or anonymize the account and associated data, and explain what is retained and why;
- verify the flow with a test account, including reauthentication and confirmation;
- make the scanner find the deletion marker in code, or record why deletion is handled entirely outside this repository.

### 7. Remove PII from logs
Fix every `pii-log` blocker. Prefer removing the value or redacting it before logging. Do not log tokens, credentials, email addresses, phone numbers, precise location, device identifiers, account identifiers, or full request/response headers in release builds.

### 8. Collect release evidence
Keep these with the release record:
- the latest `privacy_scan` report;
- the completed Data safety inventory;
- the live privacy-policy URL and a screenshot of the in-app link;
- the Play Data safety answers;
- screenshots or test output for consent and account deletion;
- the reviewer and date.

## Acceptance criteria
- Every observed permission, privacy-relevant SDK, and endpoint is either declared or explicitly reviewed as not applicable.
- The privacy policy is live, public, linked, and consistent with the inventory.
- The Data safety answers match the inventory and the declaration file.
- Account creation implies an in-app deletion path and a public web deletion URL.
- No PII-in-log blocker remains in release code.
- Static findings and manual unknowns are both recorded; neither is silently ignored.

## Anti-patterns
- Copying a policy template without replacing placeholders or matching actual practices.
- Treating permissions and SDKs as the whole inventory while ignoring backend/API payloads.
- Declaring "no data collected" because collection happens through an SDK or backend.
- Adding a deletion endpoint without an in-app path, or a web page with no working request flow.
- Logging request bodies, headers, tokens, or user identifiers "for debugging" in release builds.
- Treating this scan as a legal opinion or as proof of runtime behavior.
