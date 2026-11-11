---
"@zucker-framework/back-office": patch
"@zucker-framework/fe-auth": patch
"@zucker-framework/fe-admin": patch
---

Sign-in identifier options for the back-office account host. Defaults keep the 1.0.21 behaviour.

- back-office/accounts: `BackOfficeAccountsModule.forRoot({ login: { identifier } })` with
  `'username'` (default, body `{username, password}`), `'email'` (`{email, password}`; trimmed,
  lower-cased address matched against the stored normalized `users.email`, an address on several rows
  signs nobody in) or `'username-or-email'` (`{login, password}`; an exact username wins). Every miss
  (unknown, malformed, ambiguous, password-less, disabled, unverified) answers the same 401 after one
  hash comparison; the `login`/`login-account` budgets key on the normalized identifier. Deletion cancel
  takes the same field and deletion confirmation also accepts the address with an e-mail identifier.
  New `AccountService.verifyLoginPassword` / `findLoginAccount`, `ACCOUNT_LOGIN_IDENTIFIER_FIELDS`,
  `AccountLoginIdentifier`; `loginAccountKey(body, identifier?)`.
- back-office/accounts: `signup: { typeId }` (default `'member'`) for accounts created by register and
  OAuth sign-up.
- fe-auth: `loginIdentifierInput(identifier)` and `loginRequestBody(identifier, value, password)`.
- fe-admin: `login.identifier` selects the sign-in label, input type and request field.
