# Persistent sessions, ownership and refresh-cookie transport

These are Framework mechanisms, not product-specific implementations. Consumers retain account policy, database/model mapping, resource ownership fields and explicit grants, cookie domain/name/expiry, device labels and localization.

## PersistentSessionService

The new service uses the existing DatabaseAdapter (including PrismaAdapter), not a new connection pool. Configure modelName and sessionTtlMs. The model stores id, userId, refreshJti (unique), expiresAt, revokedAt, revokedReason and lastActiveAt. Additional consumer fields are retained by the generic session type. Create, list, lookup, single/bulk revoke, last-activity throttling and atomic refresh-JTI rotation are implemented in the package.

The database is authoritative. A missing, expired or revoked session is denied. Database errors propagate to the authentication boundary. Optional cache failures fall back to the database; only revoked entries authorize a shortcut, so stale positive cache entries cannot allow a revoked session. Compared with consumers that cache positive session status, active sessions now require a database read. Bulk revocation preserves the selected session and scopes the target snapshot to one user. Sessions created after that snapshot are not included. Rotation uses one conditional update and must change the JTI; a replay, revoked/expired session or competing refresh cannot succeed twice.

Existing TokenService remains compatible for opaque token tracking and blacklist consumers. Durable session consumers use PersistentSessionService as the session authority, rather than relying on TokenService's process-local token map to survive restarts.

## Ownership

OwnCreatedDataAccessHandler is reused, with optional explicit-grant lookup. For collection queries it returns owner filters; a detail request must look up the target and verify its actual owner, including GET. A missing record or failed ownership lookup denies access; explicit grants can authorize an existing resource owned by another user. Resolver failures also deny access.

ResourceOwnershipGuard applies this required check to ordinary JWT request.user routes with DataPermission metadata. It never installs fake permissions/authentication on the request. The consumer configures creatorField and its persisted action vocabulary. Collection/create access defaults to deny; allowCollection requires the consumer's endpoint to enforce user scoping. The guard is intentionally separate from the legacy DataPermissionGuard's optional permission-config behavior.

## HttpOnly refresh

RefreshTokenCookie issues, reads and clears cookies with consistent transport attributes and mandatory HttpOnly. Consumer configuration supplies name, secure, sameSite, domain, path and maximum age. Malformed encoding yields no token, and SameSite=None requires secure cookies. Deployment origin/CSRF policy is still required at the HTTP boundary.

The companion fe-http-client enhancement supplies refreshWithCookie, single-flight/browser-lock coordination and response error hooks. fe-auth persistOptions configures persistence before hydration so refresh tokens can stay out of JavaScript storage. Token signing, password-changed compatibility and product user/entitlement checks remain at their respective boundaries.

## Delivery

New APIs are recorded in Changesets and are not published yet. Consumers must verify the new release before deleting their implementations. Local source integration may use the documented development watcher without altering formal package versions. Release and consumer rollout require their existing stage authorizations.


Local verification (2026-09-10): 31 targeted auth/ownership/frontend-refresh tests passed; strict selected types and lint had no errors. CNIPA's source-linked session/cookie/refresh/ownership tests passed (15 tests). Real NAS cnipa_dev checks verified one concurrent refresh winner, durable revocation across service instances, current/foreign session isolation, and owner/foreign detail reads. HTTP verified Cookie-only refresh, replay rejection and access/refresh rejection after logout; browser login/logout passed. Synthetic data and caches were removed. CNIPA now directly consumes these APIs through its existing local Framework development workflow; its copied implementations and deferred patch have been removed. Registry versions still need to be updated before CI or production delivery, which have not run.
