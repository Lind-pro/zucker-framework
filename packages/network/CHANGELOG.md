# @zucker-framework/network

## 1.0.22

### Patch Changes

- @zucker-framework/core@1.0.22
  - @zucker-framework/provider@1.0.22

## 1.0.21

### Patch Changes

- @zucker-framework/core@1.0.21
  - @zucker-framework/provider@1.0.21

## 1.0.20

### Patch Changes

- Runtime hardening and correctness fixes (review round after 1.0.18).

  **script**
  - `createSandbox` no longer places any host-realm object in the vm context. The global is null-prototype backed; `console` and helpers are created inside the context; data is copied in and out (Map/Set/Date/RegExp/typed arrays preserved); host functions are reached through context-realm wrappers and their errors are re-created in the context. `codeGeneration: { strings: false, wasm: false }` and `microtaskMode: 'afterEvaluate'` are set, so `x.constructor.constructor('…')()` escapes fail and the timeout also bounds promise jobs. Timers, `FinalizationRegistry`, `WeakRef`, `Atomics`, `SharedArrayBuffer` and `WebAssembly` are unavailable.
  - BREAKING (behaviour): `eval`/`new Function` with strings throw inside scripts; scripts containing the `import` keyword are rejected; values crossing the boundary are copies (host objects mutated by a script are not changed; circular values are rejected; class instances expose own data plus their methods); a promise result that depends only on sandbox code is resolved synchronously, a never-settling promise throws instead of hanging. `allowedModules` is ignored (it already had no effect). Migration: pass data instead of live objects and read the script's return value; use the new `executeAsync()` (returned by `createSandbox`, type `AsyncSandbox`) when exposed host functions are async. `JavaScriptScriptFactory` now uses `executeAsync`. New `onLog` option routes `console.*` output (default Nest `Logger`).
  - Still not a security boundary (no memory cap): untrusted authors need an isolate/process boundary.

  **rule-engine**
  - `ExpressionEvaluator` uses the hardened sandbox (reported escapes blocked).
  - `ScriptAction`: an `onMessage` handler now runs inside the sandbox under the script timeout.
  - BREAKING (behaviour): `TimerTrigger` implements real cron (5/6/7 fields, ranges, steps, lists, names, `timezone`) instead of mapping everything to a 1 s / 1 min interval; unsupported syntax (`L`, `W`, `#`) and invalid time zones are rejected. Ticks that arrive while the previous run is still in flight are skipped. New export `parseCron`. Migration: review existing rule crons – a cron like `0 0 2 * * *` now fires once a day as written.
  - BREAKING (behaviour): `HttpAction` URL placeholders are percent-encoded, body placeholders are substituted in parsed string leaves (no JSON injection), header values drop CR/LF, redirects fail unless `followRedirects: true`, responses are capped at 1 MiB, and only the origin + path are logged. A default destination policy refuses non-http(s), credentials in URL, loopback/private/link-local/metadata addresses and `localhost`/`.local`/`.internal`. Migration: for internal webhooks call `RuleEngineService.configureHttpAction({ allowPrivateNetwork: true })` or provide `destinationPolicy`.
  - `TermsEvaluator` no longer resolves inherited names (`toString`, `constructor`) as operators; delay executors refuse delays above 2^31-1 ms instead of firing immediately.

  **cluster**
  - `RedisDistributedLock`: per-acquisition tokens (`acquireToken`/`releaseToken`/`renewToken`), atomic Lua release/renew, local state always cleared, `withLock` renews in the background (`{ watchdog: false }` to disable) and passes an `AbortSignal` aborted on lock loss.
  - `RedisClusterManager`: heartbeat errors are caught, stale/corrupt node entries are skipped and pruned (`staleNodeTimeout`), `configure()` after init joins, new `ZuckerClusterModule.forRoot/forRootAsync`. BREAKING: leadership is a renewed Redis lease (`<prefix>leader`) instead of "lowest node id"; upgrade all nodes together and use `isLeader()`/`getLeader()`.
  - `DistributedEventBus`: BREAKING wire format – messages are an envelope `{v, origin, topic, payload, headers}` (new nodes still read old messages; old nodes cannot read new ones – upgrade all nodes together). The publishing node no longer runs handlers twice, wildcard subscriptions receive remote events (`psubscribe`), subscribe failures are handled, Redis channels are unsubscribed, and local delivery happens even when the Redis publish fails (`onRemotePublishError: 'throw' | 'log'`).
  - `NodeRegistry` uses `SCAN`, skips corrupt entries and unrefs its timer.

  **buffer**
  - `PersistenceBuffer.stop()/flush()` wait for an in-flight flush and drain everything; new `maxPending` + `overflowPolicy` (`'spill'` default, `'reject'`), bounded dead-letter queue (`maxDeadLetterSize`), per-buffer file-queue directory (`tmpdir/zucker-buffer/<name>`, 0700/0600, atomic writes, files deleted only after handling, read even when memory is empty), retries resume at the failed handler, timer unref'd; ESM build reads CPU count correctly. Files spilled by older versions into the shared directory are not picked up.

  **queue**
  - `@QueueWorker` methods are registered with a `BullMqWorkerHost` supplied via the new `workerHost` module option (warning when absent); production warning when the in-memory queue default is used. `TaskLifecycleManager` passes an `AbortSignal`, clears timers, never runs overlapping retries after a timeout, prunes cancelled ids. `BullMqWorkerHost` shutdown is bounded (`shutdownTimeoutMs`, default 30 s, then force close). `ensure()` tolerates concurrent replacement. IPv6 hosts in Redis URLs are unbracketed.

  **task**
  - Tasks stranded in `RETRYING` (crash between the two retry transitions) are now requeued by `TaskQueueReconciler` (`findReadyQueued({ includeRetrying })`); the last error is kept on RETRYING→QUEUED; a failing second transition no longer fails the retry.
  - Unknown task kinds log `durable_task_kind_unsupported`, call the new `onUnsupportedKind` hook and, with `failUnsupportedKindAfterMs`, are failed with `UNSUPPORTED_TASK_KIND` (default unchanged: stay queued for rolling deploys).
  - Outbox dispatcher stops a batch before its lease expires (`leaseSafetyMarginMs`), keeps going when `markPublished`/`reschedule` throws, and supports `maxAttempts`/`onExhausted`/`exhaustedRetryDelayMs` (messages are parked with a long delay, never dropped). `TaskOutboxDispatchResult` gains `deferred`, `errors`, `exhausted`.
  - `findReadyQueued` accepts a keyset `after` cursor (`ReadyTaskCursor`), used by the reconciler instead of OFFSET paging. Custom `TaskRepository` implementations should support `after` and `includeRetrying` to get these fixes. No schema migration.

  **provider / network / datasource / relation / reference / search / timeseries**
  - `FileResourceProvider` rejects sibling-directory, `..` and absolute ids (path traversal fix).
  - `DefaultNetworkManager`: concurrent `getNetwork` shares one creation, disabled configs shut the network down, overlapping health checks are skipped, an explicitly shut-down network is no longer auto-reloaded, timer unref'd.
  - `DataSourceManager`: adapters exposing `$disconnect()`/`close()` are released on remove/close/reload/replace; `reload` builds the new adapter before swapping (a failed reload keeps the old one); `use()` outside `run()` warns; `DataSourceInterceptor` unsubscribes on teardown.
  - `RelationStore.replaceRelated` (optional) lets `saveRelated` replace atomically; stores without a remove method get a warning.
  - `ReferenceGuard` also checks `body.ids` and crud batch-delete `where.id`/`where.id.in`; orphan cleanup without a callback logs "found but not removed".
  - Search: alias + index are created atomically with `is_write_index`, alias setup is retried when health recovers, writes to an unready configured alias are refused instead of auto-creating a mapping-less index.
  - In-memory time series: no spread-argument overflow on large sets; tag values containing `|`, `=` or `,` no longer collide.

  **Re-review follow-ups (runtime / sandbox)**
  - script: a rejected promise left unhandled inside a sandbox (`Promise.reject(1)`, a failing fire-and-forget async host call) no longer terminates the process. `createSandbox` installs one process-level `unhandledRejection` guard (also exported as `installSandboxRejectionGuard()`, shared with core `evaluate()`): rejections of promises from vm realms are logged and ignored; host promises keep Node's behaviour (re-raised as an uncaught exception in the default `throw` mode, warning + exit code in `warn-with-error-code`) unless the application registered its own listener. Promises returned by host functions are pre-handled inside the sandbox; awaiting them still sees the rejection.
  - script: the host no longer calls sandbox code outside the vm timeout (result slots are polled through a trampoline script) and protocol replies are serialised without `JSON.stringify`, so `Object.prototype.toJSON` / `Array.prototype.toJSON` overrides can neither hang the event loop nor forge replies.
  - script: BREAKING (behaviour): only dynamic `import(...)` / `import.meta` (with any whitespace/comments in between) are rejected; the word `import` elsewhere (strings such as `"import done"`, identifiers) is allowed again. A host function that synchronously calls a sandbox callback (`each(list, fn)`) works again (it failed with "Re-entrant sandbox calls are not supported" in unreleased pre-1.0.20 builds); the outer call's timeout bounds it; async callbacks invoked synchronously from a host function cannot be awaited there.
  - script: BREAKING (behaviour): `new Error().stack` inside a sandbox lists only sandbox frames (no host file paths); `Error`, `Error.prepareStackTrace` and `Error.stackTraceLimit` are read-only inside the sandbox. Circular data passed in or returned still throws ("Cannot transfer a circular structure"). New `SandboxOptions.exposeMethods` (default `true`): with `false`, class instances are copied as own data only. Re-encoding the same instance no longer grows the internal host-function table.
  - rule-engine: BREAKING (behaviour): `ExpressionEvaluator` uses `exposeMethods: false`; methods of class instances in rule data are no longer callable from expressions (own data properties are still readable). Migration: put the needed values into the data.
  - rule-engine `HttpAction`: BREAKING (behaviour). The default destination policy now resolves the host and refuses it when any resolved address is loopback/private/link-local/CGNAT/multicast/reserved (including IPv6 site-local `fec0::/10`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` with private embedded IPv4, IPv4-compatible `::a.b.c.d`, Teredo); trailing dots are ignored (`localhost.`); single-label names (`redis`) and `*.svc` names are refused; the connection is made with `node:http`/`node:https` pinned to the checked addresses (no DNS rebinding window). Redirects are never followed by the transport: with `followRedirects: true` up to 5 hops are followed and every hop is re-checked (also by a custom `destinationPolicy`), custom headers are dropped on cross-origin hops and 303 (and 301/302 after POST) switch to GET; without it a redirect fails with `HTTP 3xx: redirect not followed`. A refused destination is not retried. `defaultHttpDestinationPolicy()` is now async and takes an optional resolver. New options: `resolveHost` (resolver, mainly for tests) and `fetch` (custom fetch-compatible transport, e.g. an egress proxy; it receives `redirect: 'manual'` and is not address-pinned). Migration: internal targets need `allowPrivateNetwork: true` or a custom `destinationPolicy`; code that stubbed the global `fetch` must pass `fetch` instead.
  - rule-engine cron: BREAKING (behaviour). Fixed-time schedules (minute and hour fields not starting with `*`) fire once when a local time repeats at a DST fall-back, and once right after a DST spring-forward gap that skipped their time (`30 2 * * *` in New York, `0 0 * * *` in Havana), as in Vixie cron. A day-of-month or day-of-week field that starts with `*` (e.g. `*/2`) counts as unrestricted for the OR rule, so `0 0 */2 * 1` means Mondays. Wrap-around name ranges (`FRI-SUN`) stay rejected.
  - rule-engine `TimerTrigger`: a run started before `reload()` still blocks overlapping ticks of the new schedule. Timers are process-local (every node fires); gate on `ClusterManager.isLeader()` when needed.
  - cluster `RedisDistributedLock.withLock`: the abort signal also fires when renewals keep failing (Redis unreachable) for longer than the TTL since the last confirmed renewal. `isHeldByMe()` returns false once the TTL of the last acquisition/renewal has lapsed; the key-based `acquire`/`release`/`renew` methods are marked deprecated in favour of `withLock` / the token API.
  - cluster `RedisClusterManager`: BREAKING: `configure()` throws when `heartbeatInterval >= heartbeatTimeout` (the leader lease lapsed between heartbeats). The leader lease value is `<nodeId>#<per-process random>` (a 1.0.18 lease holding the bare node id is still recognised by `getLeader()`), so two processes with the same configured `nodeId` cannot both lead. `leave()` waits for a running heartbeat; corrupt node entries are removed.
  - cluster `DistributedEventBus`: a failed `psubscribe`/`subscribe` is retried with backoff (`subscribeRetryMs`, 1 s doubling to 30 s) instead of waiting for the next `subscribe()` call; the origin id in use is logged at startup.
  - buffer `PersistenceBuffer`: spilled files are claimed by rename before they are read, so replicas sharing a directory deliver each file once; claims of dead processes are returned to the queue and orphaned `.tmp` files removed. BREAKING: a queue directory that is a symlink, owned by another user or group/world-writable is refused (items go to the dead-letter queue, `onError` is called). Large dead-letter chunks no longer hit the spread-argument limit.
  - task `TaskOutboxDispatcher`: a publish that does not finish before the lease safety margin ends the batch (counted in `errors`, remaining rows in `deferred`) and is not marked published.
  - queue `QueueWorkerExplorer`: all `@QueueWorker` methods are validated before any worker is registered; two workers for one queue (or one provider instantiated in two modules) fail bootstrap with an error naming both (only a warning when no worker host is configured). `@QueueWorker` on controllers logs a warning.
  - datasource `DataSourceManager`: an adapter still registered under another id is not released when replaced/removed; new `setDisposalOptions({ disposeOnReplace, drainDelayMs })`. Parallel `use()` inside one `run()` still shares a stack (documented; wrap each branch in `run()`).
  - search: when a concrete index already has a configured alias name (left by 1.0.18), `ensureAlias` fails with an error naming the conflict and the migration steps, and refused writes include the cause.

- Updated dependencies
- Updated dependencies
- Updated dependencies [5280170]
  - @zucker-framework/provider@1.0.20
  - @zucker-framework/core@1.0.20

## 1.0.19

### Patch Changes

- @zucker-framework/core@1.0.19
  - @zucker-framework/provider@1.0.19

## 1.0.18

### Patch Changes

- @zucker-framework/core@1.0.18
  - @zucker-framework/provider@1.0.18

## 1.0.17

### Patch Changes

- @zucker-framework/core@1.0.17
  - @zucker-framework/provider@1.0.17

## 1.0.16

### Patch Changes

- @zucker-framework/core@1.0.16
  - @zucker-framework/provider@1.0.16

## 1.0.15

### Patch Changes

- @zucker-framework/core@1.0.15
  - @zucker-framework/provider@1.0.15

## 1.0.14

### Patch Changes

- @zucker-framework/core@1.0.14
  - @zucker-framework/provider@1.0.14

## 1.0.13

### Patch Changes

- @zucker-framework/core@1.0.13
  - @zucker-framework/provider@1.0.13

## 1.0.12

### Patch Changes

- @zucker-framework/core@1.0.12
  - @zucker-framework/provider@1.0.12

## 1.0.11

### Patch Changes

- @zucker-framework/core@1.0.11
  - @zucker-framework/provider@1.0.11

## 1.0.10

### Patch Changes

- Updated dependencies
  - @zucker-framework/provider@1.0.10
  - @zucker-framework/core@1.0.10

## 1.0.8

### Patch Changes

- @zucker-framework/core@1.0.8
  - @zucker-framework/provider@1.0.8

## 1.0.7

### Patch Changes

- @zucker-framework/core@1.0.7
  - @zucker-framework/provider@1.0.7

## 1.0.6

### Patch Changes

- @zucker-framework/core@1.0.6
  - @zucker-framework/provider@1.0.6

## 1.0.5

### Patch Changes

- Updated dependencies
  - @zucker-framework/core@1.0.5
  - @zucker-framework/provider@1.0.5

## 1.0.2

### Patch Changes

- Align all public Framework packages to the maintainer-selected 1.0.2 release and keep subsequent releases synchronized through a Changesets fixed group. Package dependencies and the CLI scaffold catalog follow the same version.

  This release consolidates the pending API migrations, including breaking auth and payment persistence contracts. Review docs/package-release-1.0.2.md before upgrading from 1.0.0 or 1.0.1.

- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies [c0de08f]
- Updated dependencies
- Updated dependencies [c0de08f]
  - @zucker-framework/core@1.0.2
  - @zucker-framework/provider@1.0.2

## 1.0.0

### Major Changes

- First stable public release under the @zucker-framework organization. Publish compiled JavaScript, public type declarations, required runtime assets and Apache-2.0 license materials without source maps.

### Patch Changes

- Add Apache-2.0 license files, framework attribution, bundled third-party notices,
  and public npm publishing metadata to every library. Validate these materials
  in package contents before upload and declare required and optional runtime dependencies.
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @zucker-framework/core@1.0.0
  - @zucker-framework/provider@1.0.0
