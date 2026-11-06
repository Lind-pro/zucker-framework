# Frontend analytics

`configureAnalytics`, `trackEvent`, `trackPageView` and `flushEvents` provide browser event buffering and best-effort unload delivery. Existing consumers retain the default array payload and beacon transport. `defineEventCatalog(names)` turns a product's event list into a typed `track` (unlisted names fail type checking) and a `has` check the receiving server can use to drop unknown names.

For an API that accepts individual events, set `batchSize: 1`, `flushInterval: 0`, and `serializeEvents: ([event]) => JSON.stringify(event)`. The serializer defines the wire fields; remove fields the API does not accept or the product does not collect. Configure `getHeaders` for dynamic authentication headers. Its presence uses `fetch` with `keepalive: true`, including anonymous events when it returns `{}`, because `sendBeacon` cannot set authorization headers. A refused beacon falls back to fetch.

`sessionStorageKey` and `createSessionId` preserve an application's existing anonymous-session format. Blocked browser storage falls back to a stable identifier in memory. `getSessionId` remains available for an externally managed identity. Server rendering does not track browser events.

This package does not select product events, consent rules, provider channels or endpoints. Applications retain those policies and can disable collection with `enabled: false`. Delivery failures are best effort; events are not durable and are not retried.

The transport and compatibility test sources are in `src/analytics.transport.spec.ts` and `src/analytics.spec.ts`. This source change still requires validation and an immutable release before published-package consumers use the added configuration.

## Optional site analytics connections (local source, not yet released)

The separate `@zucker-framework/fe-analytics/site-analytics` entry exports `resolveSiteAnalytics(config)` and its typed configuration/plan. Importing or resolving this entry has no browser, network, session-storage or unload-listener side effects. The existing first-party event transport is unchanged.

Both `config.enabled` and an individual provider's `enabled` must be exactly `true`. The resolver returns ordered bootstrap/loader descriptors with stable IDs and independent configuration issues; an invalid provider emits no scripts without blocking the others. A host such as Next.js mounts these descriptors with its own script loader, nonce and error policy. Only public site IDs/configuration belong here; server secrets and automatic user identification are not accepted.

| Provider | Explicit connection settings | Protocol reference |
| --- | --- | --- |
| Google Analytics 4 | `google.measurementId` (`G-…`) | [Google pageview documentation](https://developers.google.com/analytics/devguides/collection/ga4/views) |
| Microsoft Clarity | `clarity.projectId` | [Setup](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup), [client API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api) |
| Plausible | `plausible.scriptUrl`: this site's current installation URL, or a configured same-origin proxy | [Current script configuration](https://plausible.io/docs/script-update-guide), [installation queue](https://plausible.io/docs/proxy/guides/fresh) |
| OpenPanel | public `openPanel.clientId`, optional HTTPS/same-origin `apiUrl` | [Script tag API](https://openpanel.dev/docs/sdks/script) |
| Vercel Web Analytics | `vercel.scriptPath`: this project's same-origin script path | [Vercel installation](https://vercel.com/docs/analytics/quickstart) |

These connections use provider automatic page tracking, not a second application pageview emitter. Configure GA enhanced measurement/history behavior in its dashboard; do not also send manual pageviews for the same navigation. OpenPanel outbound-link/attribute tracking and session replay are not enabled by this connector. Plausible uses its current per-site script and `plausible.init`, not the former shared `data-domain` snippet. Vercel requires the platform feature/routes to be enabled; copying a script path does not provision them.

This is page-load configuration, not a consent-management system. The application must determine whether loading a provider is permitted before mounting it and pass provider-specific consent signals if its policy requires them. No consent is inferred or granted here. Disable or change configuration on a full page load: removing a script node or unmounting a component does not unload an already executed SDK. Do not claim that this mechanism revokes an active provider's tracking.

Tests use synthetic IDs and execute only our queue/bootstrap code in isolated sandboxes; no real provider script or account receives test events. Public artifact consumption and provider-account reporting remain separate validations. Advertising, affiliation and support widgets are outside this entry's responsibility.
