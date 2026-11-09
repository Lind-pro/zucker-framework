# Frontend authentication

`createAuthStore` provides typed Zustand authentication state, pluggable token/user storage, configurable persistence, permission matching and logout callbacks. The consumer owns its user shape, permissions, login routes, refresh-token policy and business cleanup.

`createUseAuthHydration(store)` binds a React hook to a store's optional Zustand `persist` API. It subscribes to completed hydration, returns `false` for server rendering or unavailable persistence, and disposes the subscription on unmount. This prevents applications from treating the first render before persistence is restored as an expired session.

`isSafeRelativeRedirect(value)` accepts only a local path beginning with `/`; it rejects schemes, protocol-relative paths, backslashes and CR/LF. Locale prefix removal, allowed destinations and fallback routes remain consumer policy. It expects the already-decoded query value used for navigation.

Session binding (`session.ts`) keeps a signed-in tab on one session. `jwtSessionKey(claims)` builds a comparison key from JWT claims the application chooses (for example `['sub', 'sid', 'cv']` for subject, persistent session id and credential version); the claim names stay consumer policy. `acceptsSessionToken(state, token, key)` allows a refreshed or header-supplied token only when it belongs to the current session, `sessionIdentity(state, key)` exposes the comparison value, and `createSessionRequestScope(read, subscribe, key)` returns an `AbortSignal` source that cancels in-flight requests when the user or session changes while surviving ordinary token rotation. Decoding a token only identifies a session for comparison; it never authorizes a request. Tests: `src/session.spec.ts`.

The package keeps React and Zustand as peer dependencies and has no dependency on a product or backend package. New exports require validation and an immutable package release before published consumers can adopt them. Focused test sources are `src/hydration.spec.tsx`, `src/redirect.spec.ts` and the existing store tests.
