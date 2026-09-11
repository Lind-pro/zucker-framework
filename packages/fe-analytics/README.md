# Frontend analytics

`configureAnalytics`, `trackEvent`, `trackPageView` and `flushEvents` provide browser event buffering and best-effort unload delivery. Existing consumers retain the default array payload and beacon transport.

For an API that accepts individual events, set `batchSize: 1`, `flushInterval: 0`, and `serializeEvents: ([event]) => JSON.stringify(event)`. The serializer defines the wire fields; remove fields the API does not accept or the product does not collect. Configure `getHeaders` for dynamic authentication headers. Its presence uses `fetch` with `keepalive: true`, including anonymous events when it returns `{}`, because `sendBeacon` cannot set authorization headers. A refused beacon falls back to fetch.

`sessionStorageKey` and `createSessionId` preserve an application's existing anonymous-session format. Blocked browser storage falls back to a stable identifier in memory. `getSessionId` remains available for an externally managed identity. Server rendering does not track browser events.

This package does not select product events, consent rules, provider channels or endpoints. Applications retain those policies and can disable collection with `enabled: false`. Delivery failures are best effort; events are not durable and are not retried.

The transport and compatibility test sources are in `src/analytics.transport.spec.ts` and `src/analytics.spec.ts`. This source change still requires validation and an immutable release before published-package consumers use the added configuration.
