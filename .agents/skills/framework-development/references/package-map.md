# Package discovery map

Use this map for routing; confirm actual exports and tests before using an API. It replaces the root's copied signature catalogue.

| Need | Candidate package |
| --- | --- |
| Scoped context, retry/error classification, lifecycle primitives | @zucker-framework/core |
| Nest request context and cross-cutting integration | @zucker-framework/common |
| Configuration sources and validation | @zucker-framework/config |
| CRUD/database adapters and query contracts | @zucker-framework/crud |
| AI calls, provider configuration, observations and cost interfaces | @zucker-framework/ai |
| Credential profiles and approved provider access | @zucker-framework/ai-access |
| Authentication, permissions, tenancy | @zucker-framework/auth, @zucker-framework/tenant |
| Credit ledgers, quota capacity, entitlements and per-resource charges; payment provider/persistence contracts, plan catalog/prices and user subscription assignment | @zucker-framework/credit, @zucker-framework/payment |
| Request admission and rate limits | @zucker-framework/rate-limiter |
| State/lease/fencing and queue transports | @zucker-framework/task, @zucker-framework/queue |
| Events, storage, notifications | @zucker-framework/event, @zucker-framework/storage, @zucker-framework/notification |
| Logs, required audit interfaces, metrics and tracing | @zucker-framework/logging, @zucker-framework/monitoring, @zucker-framework/tracing |
| Frontend HTTP/SSE, keepalive cookie refresh, storage, forms, auth and cookie sessions | @zucker-framework/fe-http-client, @zucker-framework/fe-storage, @zucker-framework/fe-form, @zucker-framework/fe-auth |
| Back-office shell and management pages (Radix + Tailwind) | @zucker-framework/fe-admin |
| Shared client types (incl. `fe-types/back-office` wire contract and `PortErrorReason`) and media safety | @zucker-framework/fe-types, @zucker-framework/media |
| Circuit, reaction and scientific SVG renderers | python/zucker-framework-render; TypeScript render clients in @zucker-framework/media |
| Project scaffolding and diagnosis | @zucker-framework/cli |

Read packages/<name>/src/index.ts, package.json#exports and the relevant nearby spec. Only then inspect a deeper implementation. Do not assume every observer is durable, every helper retries safely, or a particular source-priority/cache-TTL remains unchanged.

Framework extension sequence: demonstrate a consumer need → check existing mechanisms → define a neutral contract → implement and test → version/export/document → validate artifact and consumer → authorized release/integration. Package extraction and consumer migration are not implicit side effects of a bug fix.
