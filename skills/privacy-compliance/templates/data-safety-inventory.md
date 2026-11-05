# Data safety inventory — [APP NAME]

Fill this from code, SDK documentation, backend/API data flows, on-device
storage, and developer declarations. Do not fill it from permissions and SDKs
alone. For every row, link the evidence and name the reviewer.

- App version / commit: [VERSION / COMMIT]
- Inventory date: [YYYY-MM-DD]
- Owner: [NAME]
- Privacy policy URL: [URL]
- Public account-deletion URL: [URL or "not applicable"]
- Play Data safety form last updated: [YYYY-MM-DD]

## 1. Data types

Use one row per data type. "Collected" means sent off the device or otherwise
accessible to the developer or a third party. On-device-only storage still needs
a security/retention note.

| Data type | Collected | Shared | Purpose | Source / evidence | Retention | Optional? | Play Data safety answer |
|---|---|---|---|---|---|---|---|
| [Name, email, phone] | [yes/no] | [yes/no — recipients] | [account, support] | [path or document] | [period] | [yes/no] | [answer] |
| [User content] | | | | | | | |
| [Usage / analytics] | | | | | | | |
| [Crash / diagnostics] | | | | | | | |
| [Device or advertising ID] | | | | | | | |
| [Location] | | | | | | | |
| [Health / fitness] | | | | | | | |
| [Payments] | | | | | | | |
| [Other] | | | | | | | |

## 2. SDKs and third-party services

List every privacy-relevant SDK, including transitive dependencies. Record what
the SDK receives, whether it runs in release builds, and where it is initialized.

| SDK / artifact | Provider | Data received | Purpose | Initialized at | Release build? | Evidence |
|---|---|---|---|---|---|---|
| [artifact] | [provider] | [data] | [analytics/crash/ads] | [path] | [yes/no] | [docs/path] |

## 3. Backend and API flows

List endpoints that receive user or device data. Include endpoints not present in
the app repository. For each, record the request fields, response fields,
retention, and whether the data is shared onward.

| Endpoint / host | Trigger | Data sent | Data returned | Stored by backend? | Retention | Evidence |
|---|---|---|---|---|---|---|
| [api.example.com] | [sign-in] | [email, token] | [profile] | [yes/no] | [period] | [API doc/path] |

## 4. On-device storage

| Store | Data | Encrypted? | Backup? | Retention / deletion | Evidence |
|---|---|---|---|---|---|
| [Room / DataStore / SharedPreferences] | [data] | [yes/no] | [yes/no] | [rule] | [path] |

## 5. Permissions and disclosures

| Permission | Feature that needs it | Runtime prompt? | Denial path | Disclosure |
|---|---|---|---|---|
| [CAMERA] | [scan document] | [yes/no] | [manual entry] | [policy/UI] |

## 6. Consent and legal basis

| Data / flow | Consent required? | Basis | UI / disclosure | Withdrawal path | Evidence |
|---|---|---|---|---|---|
| [analytics] | [yes/no] | [consent/contract/legitimate interest] | [screen] | [settings] | [path] |

Record the jurisdictions, user ages, and app category that drive these answers.
This table is not a legal opinion.

## 7. Account deletion

- Does the app allow account creation? [yes/no]
- In-app deletion path: [screen / deep link / not applicable]
- Public web deletion URL: [URL / not applicable]
- Data deleted: [account, profile, content, analytics identifiers]
- Data retained and why: [legal/accounting/security]
- Identity verification: [method]
- Expected completion time: [period]
- Test evidence: [date, tester, result]

## 8. Declarations vs evidence

| Declaration | Declared value | Observed evidence | Match? | Reviewer / date |
|---|---|---|---|---|
| Permissions | [list] | `privacy_scan` report | [yes/no] | [name] |
| SDKs | [list] | Gradle + SDK docs | [yes/no] | [name] |
| Endpoints | [list] | Source + backend docs | [yes/no] | [name] |
| Account creation/deletion | [yes/no] | Code + tested flow | [yes/no] | [name] |
| Policy and Data safety form | [URL/answers] | Inventory | [yes/no] | [name] |

## 9. Open questions and sign-off

- Unverified backend flows: [list]
- Unverified runtime behavior: [list]
- Legal/privacy review: [name, date]
- Release decision: [ship / block / conditions]
