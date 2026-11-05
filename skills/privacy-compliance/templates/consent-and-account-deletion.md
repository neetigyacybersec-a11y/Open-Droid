# Consent, disclosure and account deletion — [APP NAME]

Select only the rows that apply to the product and the jurisdictions it serves.
Record why each row applies or does not apply. This is a decision record, not a
legal opinion.

## 1. Consent and disclosure decision table

| Trigger | Applies? | Required flow | Evidence |
|---|---|---|---|
| Analytics or crash reporting | [yes/no] | Disclose in policy and Data safety; obtain consent first where required | [path/URL] |
| Advertising or attribution | [yes/no] | Disclose partners and data; provide required opt-out or consent | [path/URL] |
| Precise or background location | [yes/no] | Just-in-time runtime permission, clear purpose, disclosure, denial path | [path/URL] |
| Camera, microphone, photos | [yes/no] | Request in context; explain use; allow manual alternative when feasible | [path/URL] |
| Contacts, calendar, SMS, call log | [yes/no] | Runtime permission, purpose disclosure, limited use, denial path | [path/URL] |
| Health, fitness, biometric data | [yes/no] | Explicit disclosure and consent where required; special-category review | [path/URL] |
| Accounts and profile data | [yes/no] | Privacy notice at or before collection; deletion path | [path/URL] |
| Payments and subscriptions | [yes/no] | Disclose processor, renewal, cancellation and refund terms | [path/URL] |
| Children or teen audience | [yes/no] | Age-appropriate notice and parental consent where required | [path/URL] |
| Data transferred internationally | [yes/no] | Disclosure and transfer safeguards where required | [path/URL] |
| Personalized content or profiling | [yes/no] | Disclosure and opt-out/consent where required | [path/URL] |

For every "yes", verify the flow:
- the disclosure appears before or at the point of collection;
- the permission request explains the user-visible benefit;
- denial does not trap the user in a broken screen;
- the setting can be changed later;
- the policy and Data safety answers match the behavior.

## 2. Account deletion checklist

Complete this section only when the app enables account creation.

### Product and UI
- [ ] In-app entry point: [Settings > Account > Delete account / deep link].
- [ ] Explains what will be deleted, what will be retained, and why.
- [ ] Requires a clear confirmation; reauthenticate when appropriate.
- [ ] Shows success, failure, and pending states.
- [ ] Provides a support contact if deletion cannot complete.

### Web path
- [ ] Public URL: [URL].
- [ ] Reachable without installing the app.
- [ ] Accepts a deletion request and explains identity verification.
- [ ] States expected completion time.

### Backend and data
- [ ] Deletes or anonymizes the account record.
- [ ] Deletes user content and associated files.
- [ ] Deletes or disassociates analytics/device identifiers where required.
- [ ] Retains only what law or security requires, with a stated period.
- [ ] Cancels subscriptions or explains the separate store-managed process.
- [ ] Invalidates sessions and tokens.

### Verification
- [ ] Test account created: [date].
- [ ] Deletion started in app and via web: [date].
- [ ] Account cannot sign in after deletion: [result].
- [ ] Data removed or anonymized: [result].
- [ ] Retention exception documented: [result].
- [ ] Tester and reviewer: [names].

## 3. Sign-off

- Consent/disclosure owner: [name, date]
- Account-deletion owner: [name, date]
- Privacy/legal reviewer: [name, date]
- Open issues: [list]
