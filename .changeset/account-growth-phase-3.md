---
"@zucker-framework/auth": patch
"@zucker-framework/fe-auth": patch
"@zucker-framework/admin": patch
"@zucker-framework/fe-admin": patch
"@zucker-framework/fe-types": patch
"@zucker-framework/payment": patch
"@zucker-framework/storage": patch
---

Account growth and security (phase 3): two-factor sign-in, role expiry, OAuth popups, promotions,
streamed S3 uploads and the back-office pieces for them.

**BREAKING (D19) — auth:** `@Permissions(['a', 'b'])` (an array) now throws a `TypeError` when the
class is loaded; write `@Permissions('a', 'b')`. The array form was never enforced correctly: it
stored `[['a','b']]` and every request failed the permission check. Same for
`@Authorize({ permissions })` with nested arrays, blank or non-string codes. `@Permissions()` (any
signed-in user) is unchanged. Consumers must grep for `@Permissions([` before upgrading.

- auth: TOTP helpers (`generateTotpSecret`, `totpProvisioningUri`, recovery codes and hashing) and
  `TotpValidator.verifyOnce(userId, code, secret?)`. Verification is serialised per user, so concurrent
  submissions of one code accept it once and concurrent wrong guesses cannot all pass the lockout
  check; `TwoFactorStateStore.advanceCounter` (optional) is an atomic compare-and-set of the last used
  step for shared stores; `isLockedOut` / `recordFailedAttempt` let other factors (recovery codes)
  share the lockout. Opt-in role expiry: `ZuckerAuthModule.forRoot({ roleAssignments: { expiry: true } })`
  (requires `userRoles.expiresAt`); expired links grant nothing to permissions, role dimension, menus
  and hierarchy, and the permission cache never outlives the earliest expiry.
- admin: `GET/PUT /users/:id/roles` carry per-role `expiries` when role expiry is on (400 otherwise).
- fe-admin: two-factor step on the login page (`AdminTwoFactorRequiredError`, `loginTwoFactor`), role
  expiry dates in the role dialog, an optional "Reset 2FA" action (`users.twoFactorResetPath`), and the
  order ledger shows the amount charged, the discount and the list price.
- fe-auth: `openOAuthPopup` / `claimOAuthPopup` (BroadcastChannel; `blocked` falls back to redirect).
- fe-types: `PublicBillingCheckoutPolicy.promoCodes: 'none' | 'alias'`, `UserRoleExpiries`,
  `UserRolesResponse.expiries`.
- payment: server-frozen promotions on hosted checkout (`HostedCheckoutOffer.promotion`,
  `checkoutPayable`, `snapshotPromotion`; provider subtotal, discount and reference are verified, and
  a discount on an order without a promotion fails). Codes that bring the total to zero are refused;
  subscriptions are discounted on the first invoice only (`initialMoney`). Stripe applies each
  promotion as a per-session, single-use, `once` coupon with the server-computed fixed `amount_off`
  (never a percentage), so Stripe's total always equals the frozen payable; the frozen provider code
  travels in session metadata (`zucker_promotion_code`, now a reserved metadata key) and is reported
  back as the discount reference. Without the `coupons` API on the client, promotions are refused.
  Stripe sessions with an empty `discounts` list report the reference as unknown (amounts are still
  verified). PayPal and Creem refuse promotions.
- storage: `S3FileManager.uploadStream` uploads in multipart parts (`partSize`, default 8 MiB,
  5 MiB–5 GiB, one part in memory, aborted on failure) instead of buffering the whole object.

Server, web and admin templates (copied by `zucker create`, not versioned): two-factor sign-in and
setup with a local QR code, magic links (off by default), account deletion with a 7-day grace period
and per-feature erase contributors, staff 2FA reset, in-app notifications, feedback, promotions,
referrals (off by default), operations insights, streamed private-file downloads with an orphan
sweeper, and a test-only fake payment provider (`BILLING_TEST_FAKE_PROVIDER`, refused in
production). Migrations `20261111010000`…`20261111090000` are additive; the last adds indexes with
plain `CREATE INDEX` (run during a quiet period on large tables). The Prisma schema now declares the
billing refund relations and index names that the migrations already created, so
`prisma migrate diff` is empty for the whole database.
