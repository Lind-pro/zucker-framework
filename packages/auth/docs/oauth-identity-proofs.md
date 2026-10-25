# Verified OAuth identities and explicit binding proofs

The public APIs here are server mechanisms. They neither create users nor merge them by email, grant roles, admit a user, choose a tenant, or issue a session. Use `ThirdPartyAccountService.findAccount(provider, subject)` and consumer-owned policy after verification. Never pass a browser profile to `bindAccount` or the legacy `findOrCreateUser` email-merge path.

## Google One Tap

Create one `GoogleIdTokenVerifier` per configured server application and reuse it, so requests share its public-key cache:

```ts
import { GoogleIdTokenVerifier } from '@zucker-framework/auth';

const google = new GoogleIdTokenVerifier({ audience: configuredGoogleClientId });
// These values come from a server-stored, browser-bound login/link intent.
// Validate purpose, user/session (for linking), CSRF and expiry, then atomically
// consume that intent. Neither expectedNonce nor clientId comes from the body.
const identity = await google.verify(request.body.credential, {
  nonce: storedIntent.nonce,
  signal: requestSignal,
});
```

Send the server-generated nonce to GIS during initialization, and compare the returned signed claim to the stored value. The verifier requires a nonce; it does not persist or consume an intent. A signed ID token can otherwise be replayed until expiry. A nonce copied from the credential or another body field provides no protection. `OAuthStateService` remains the browser-cookie state check for authorization-code callbacks, but clearing a cookie alone does not atomically prevent two concurrent callback requests. Consume a server intent once as well.

`verify` uses only Google's fixed official JWKS endpoint, verifies RS256 with Node's cryptographic implementation and a public RSA key of at least 2048 bits, and rejects unsupported algorithms/critical headers. It validates `iss`, configured `aud`/`azp`, integer `iat`/`exp`, optional `nbf`, immutable `sub`, the expected nonce and a boolean `email_verified: true`. It returns a small identity projection; it never returns the ID token, nonce or provider access tokens. Default clock tolerance is zero; an explicit tolerance is limited to 300 seconds.

The cache honors `Cache-Control` and `Age`, with a 24-hour cap (configurable downwards) and a 5-minute fallback when max-age is absent. Key loads are shared. An unknown `kid` can force one refresh per 30 seconds, including Google's normal new-key rotation. Expired cached keys are never accepted after a failed refresh. Refresh failures are also held for 30 seconds to bound provider load. Known valid cached keys remain usable during an unrelated unknown-key fetch failure. A configured timeout defaults to 5 seconds and is limited to 30 seconds; caller cancellation does not cancel other callers' shared key fetch. Errors expose only a fixed reason, not credentials, claims, response bodies or transport causes.

A verified email claim does not authorize automatic account merging. Google may have verified an external email long ago without currently hosting that mailbox. Admission and any additional ownership proof remain consumer policy. See the official [server verification guide](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [GIS nonce reference](https://developers.google.com/identity/gsi/web/reference/js-reference#nonce), [OIDC claims](https://developers.google.com/identity/openid-connect/openid-connect#an-id-tokens-payload), and [discovery document](https://accounts.google.com/.well-known/openid-configuration).

For GIS's automatic POST integration, validate its `g_csrf_token` cookie/body pair before checking the credential. A consumer's JavaScript callback integration must enforce its own same-origin/CSRF contract. The verifier's cryptographic checks do not replace either requirement.

## One-time login and linking handoffs

`OAuthProofService<Credential>` reuses `OneTimeTicketService<OAuthProofRecord>`. Configure `verifyIdentity` with a server verifier or the existing `exchangeGoogleOAuthCode` / `exchangeGitHubOAuthCode` transport after validating and consuming the stored provider intent. Its input is an untrusted credential, not an identity/profile. The verified result must include the provider and immutable subject. The code transports expose email verification only when backed by provider evidence (Google userinfo or GitHub with `includeEmailVerification: true`); map `emailVerified: false` when no such evidence exists. `false` does not reject a proven provider subject and never authorizes email merging.

```ts
const proofs = new OAuthProofService({
  tickets: new OneTimeTicketService(ticketStore, {
    expirySeconds: 120,
    consumedRetentionSeconds: 3600,
  }),
  verifyIdentity: async (credential: string) =>
    google.verify(credential, { nonce: consumedServerIntent.nonce }),
});

const context = {
  purpose: 'link' as const,
  provider: 'google',
  userId: authenticatedUser.id,
  sessionId: authenticatedSession.id,
  browserBinding: protectedBrowserCookie,
};
const proof = await proofs.issue(providerCredential, context);
// Later, reconstruct context from the currently authenticated request and
// its protected cookie, not fields in the request body.
const verifiedIdentity = await proofs.consume(proof, context);
```

The browser secret should contain at least 128 random bits. Proofs persist only their SHA-256 hash, a hash of that browser secret, a bounded identity projection, purpose and (for linking) the current user/session IDs. Provider credentials are not persisted in this handoff. Login and linking proofs cannot substitute for each other. Mismatched provider, user, session, browser or purpose is rejected **before** the ticket claim, so an incorrect request cannot burn a valid proof. The optional synchronous `OneTimeTicketService.consume(code, validate)` callback must throw on mismatch or return undefined; asynchronous/boolean validation is rejected before claim.

The backing `OneTimeTicketStore.claim` must atomically require unconsumed and unexpired state; its fields must be immutable after issuance. `DatabaseOneTimeTicketStore` supplies that predicate for compatible models. A mocked store proves the package contract, not a consumer's SQL uniqueness, isolation or transaction adapter.

## Generic HTTP binding endpoint

`POST /third-party-account/bind/:provider` now accepts only `{ proof }`. Without `thirdPartyAccounts.resolveBindingProof`, it rejects the operation. The resolver receives the authenticated request, user ID, route provider and proof; it must derive the session/browser context from that request and consume the appropriate linking proof. Return only the verified `ThirdPartyProfile` projection. Extra client profile/user fields cannot determine the binding target.

The service-level `bindAccount` remains a trusted primitive and keeps its existing ownership and locking behavior. `withUserLock` must serialize relevant bind/unbind operations in the consumer's transaction. The database must also uniquely constrain `(provider, providerAccountId)`; application reads cannot replace cross-user uniqueness.

The generic resolver consumes the proof **before** `bindAccount` runs, in separate operations unless the consumer explicitly supplies a shared transaction. If the binding fails afterwards, the proof stays spent: the user must complete a fresh provider flow. Do not promise atomic rollback or silently retry a used proof. For an atomic claim-and-bind operation, use a consumer controller with `IdentityTransactions.run`, construct both the ticket store and binding adapter from that transaction, and roll back the claim with the binding write. Also serialize provider-subject ownership across different users and account-level bind/unbind changes; lock ordering and uniqueness remain the consumer's responsibility. No transaction pool, schema, email merge or ownership policy is created by these APIs.

## Verification scope

Package tests sign local RSA tokens and replace JWKS/provider requests. They cover signature/claims, nonce and email trust, cache expiry and rotation, bounded failures, cancellation, context isolation, single-use claims and the raw-profile rejection boundary. They make no live Google/GitHub account calls. Provider-app credentials, browser consent/FedCM, persistent intents, SQL concurrency, cookies/CSRF and session issuance must be verified in the consumer integration before enabling the feature.
