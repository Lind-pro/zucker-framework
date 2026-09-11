# OAuth code transport

`exchangeGoogleOAuthCode` performs the authorization-code token exchange and Google userinfo request. `exchangeGitHubOAuthCode` exchanges a code, reads the GitHub profile, and requests primary email only if the public profile has no email. Both return typed profile projections with provider/id/email/name/avatar/accessToken/refreshToken fields matching ordinary OAuth profile handlers; GitHub also returns username/profileUrl.

Applications provide client credentials, authorization code and (Google) redirect URI explicitly. No environment variables, application routes, user creation, linking, state verification or email-verification policy are built into this transport. GitHub primary-email selection retains provider ordering and does not imply email verification. Use the existing product profile handler for identity/account decisions.

Native fetch can be injected; an optional AbortSignal is passed to every request and cancellation errors retain their identity. Non-success HTTP, missing token, invalid profile and malformed JSON fail with OAuthCodeExchangeError(provider, stage, status). An errorFactory maps those failures into localized application errors. Provider bodies/tokens are never placed in error messages; no retries or new time budgets are imposed.

No OAuth requests, tests, typechecks, lint, builds or dependency installation were executed during this source-only extraction. The independent test source uses fetch replacements and synthetic profiles.
