# Admin APIs

The package provides optional feature modules and configurable controllers. Applications configure the database and authentication once at their composition root.

For persistent audit management, use `createAccessLogAdminController` and `createOperationLogAdminController` with the host's route, resource and audit labels. They use `AccessLogService` / `OperationLogService` configured by `ZuckerLoggingModule.forRoot({ persistence: ... })`. `createLogQueryController` adds the shared read, timeline, statistics, metrics and CSV endpoints; permission codes and export labels are host configuration. Existing default feature modules remain available for their documented contracts.

`createReadOnlyAdminController` exposes only `GET /` and `GET /:id` for a configured database model. Pagination executes in the database and is capped at 100 records by default. Only configured equality filters and the record ID are accepted. Both plain query parameters and the Framework frontend's `filters={"field$eq":"value"}` encoding are supported; arbitrary operators, fields and model names are not forwarded to storage. Business mutations such as credit or reservation transitions belong to their business APIs.

Set `projection` for any model with private columns. A list keeps field names; a record maps response keys to model fields (`{ userId: 'subjectId' }`). With a projection only those columns are selected, the response uses the response keys, and filters/`id` refer to response keys (each configured filter must be projected; `id` is filterable only when the projection includes it, so composite-key models such as quota usage never send an `id` filter to storage). Without it the whole record is returned as before. `createReadOnlyRecordReader` exposes the same bounded reader for composing custom controllers.

Controller factories use `JwtAuthGuard` and `PermissionsGuard` by default. Hosts with equivalent global guards can pass `guards: []`; route permission metadata remains present and is enforced by those global guards. Do not register unguarded generated controllers in an application without global authentication and authorization.

## Configured catalogs and AI models

`createCatalogAdminController` supplies a constrained REST catalog backed by the existing CRUD `BaseService`: configured list/detail relations and filters, bounded pagination, create/update field allowlists and soft deletion. Configure the resource, guards and `createAction` to preserve the application's persisted permission names. Route/model/schema policy remains host configuration; no unrestricted query or mutation routes are inherited.

`createAIModelAdminController` exposes the persistent `AIModelCatalogService` with configured read/read-secret/create/update/delete permissions. Register specialized host routes (such as subscription or runtime-cache administration) before its parameterized `:id` route. `createResendWebhookController` exposes signed mail callbacks; enable raw-body capture at Nest bootstrap and configure one `ResendWebhookService` with the host suppression policy. Bad signatures return 401, invalid payloads 400, and persistence failures 503 for provider retry.

## Default administrative permissions

Default static controllers require an explicit `<resource>:query` capability for reads, including `POST /_query` and `POST /_count`. Resources are `users`, `roles`, `permissions`, `dictionary`, `config`, `credit`, `logging`, `notification`, `form`, `i18n`, `tenant`, and `dashboard`. Mutating routes require the existing Admin UI actions `:add`, `:update`, or `:delete`; permission-definition synchronization requires `permissions:update`. Notification template creation rejects an existing ID instead of overwriting a template through `notification:add`. Public `/health` remains a liveness endpoint. Configurable controller factories retain their application-supplied permission contracts.

User role, direct-permission and dimension binding writes require **`users:authorize`**. `users:update` alone cannot assign authority. Creating a role with permissions, inherited authority or the reserved `superadmin` name also requires **`roles:authorize`**, in addition to `roles:add`. Updates that replace `permissionIds`, change `parentId` or rename a role require `roles:authorize` in addition to `roles:update`; ordinary description changes need only `roles:update`. Roles accept explicit scalar metadata and `permissionIds`, never nested ORM relation writes. Authorization changes invalidate permission caches so removed grants do not remain active in the current service instance.

Role creation and editing commit metadata and permission links in one transaction. Updates lock the
role parent before reading its current name and replacing grants, including an initially empty set.
Deletes acquire that same role lock before deleting permission and membership links. These operations
lock roles before their associations and never lock users; user-role assignment uses its separate
user-before-roles order. Failed writes roll back the entire role change, and caches invalidate only
after successful completion. PostgreSQL concurrency and rollback checks live in
`templates/server/test/roles-atomic.persistent.e2e-spec.ts`.

Existing custom roles that formerly relied on login-only access must receive the intended capabilities explicitly. Do not grant all permissions to ordinary registered accounts to preserve the former behavior. Frontends should condition assignment controls on the authorization capability; hiding a control never replaces the API checks. These are administrative resource permissions; product-specific row ownership and tenant restrictions remain host responsibilities.

## Form definition persistence

The default form manager uses the host's persistent `FormService`. `POST /form/definition` requires
`form:add`, accepts the existing definition fields and supplies an ID plus `fields: []` when omitted.
`PUT /form/definition/:id` requires `form:update` and updates name, description, fields or layout;
identity/timestamps are not writable through this route. The definition and informational version
are written in one model update. This retains the existing last-write-wins editing contract and does
not introduce optimistic concurrency. Missing forms return 404 and database unique conflicts return
409 without overwriting the existing definition. Invalid/duplicate field keys are rejected.

The Admin template preserves draft values after a failed create/save and displays an explicit retry
message in Chinese or English. Its preview remains clearly labeled as preview-only. The integration
checks are `templates/server/test/form-engine.persistent.e2e-spec.ts` and the opt-in
`form-engine.browser.e2e-spec.ts` (`RUN_FORM_ENGINE_BROWSER=1`), using a disposable development schema
and actual administrator HTTP routes.

## Dictionary definition persistence

The default dictionary manager provides `PUT /dictionary/:id` and `PUT /dictionary-item/:id`,
both protected by `dictionary:update`. Creation remains `dictionary:add`; queries require
`dictionary:query`. Updates accept editable scalar/JSON fields, never IDs, owner reassignment,
or nested ORM relation writes. Item lists accept either `filter.dictId` or `filter['dictId$eq']`,
reject conflicting scopes, and paginate the existing service results with a maximum page size of
100. The default manager retains in-process pagination, not a new database query engine.

Item payloads use `text`/`ordinal`; former `label`/`name` and `sortIndex` payloads remain accepted.
The dictionary service maps these to the existing canonical schema. Duplicate values in one
dictionary return 409, missing records return 404, and failed writes are not returned as success.
See `templates/server/test/dictionary.persistent.e2e-spec.ts` for the actual PostgreSQL/HTTP checks.
## List filters

The users, roles and permissions `_query`/`_count` endpoints translate `filter` with `toAdminWhere`, which is an allow-list on both sides: `USER_FILTER`, `ROLE_FILTER` and `PERMISSION_FILTER` name the fields that accept exact matching (`field` / `field$eq`) and the text fields that accept `field$like` (case-insensitive substring). Any other key — credential or login-metadata columns, columns added later, relation names, ORM combinators such as `AND`/`OR`/`NOT`, object values or other operators — is rejected with 400. Pages are read with `skip`/`take` and a stable `id` order in the database (`adminPage` bounds `pageIndex`/`pageSize`); substring search is a sequential scan, so large user tables should add a trigram index (`CREATE EXTENSION pg_trgm; CREATE INDEX … USING GIN (username gin_trgm_ops)`) where the database allows that extension.

## Permission definition input

Permission create/update accept only definition metadata: identifier (create or unchanged on edit),
name, description, status, actions, optionalFields, parents and properties. Unsupported fields are
rejected before persistence. Membership writes remain in the separate user/role authorization
operations; changing a definition does not accept nested membership commands.

## Back office: plans, subscriptions, quota and mail logs

These factories implement the shared back-office contract (`docs/back-office-rfc.md` §8.2–8.5, §8.8). Paths and permission codes default to the RFC and can be overridden. Business rules live behind injected structural ports (`…Port`) so this package keeps no dependency on `@zucker-framework/payment`; request/response types come from `@zucker-framework/fe-types/back-office`. `mapPortError`/`viaPort` translate only errors branded with `PORT_ERROR` (PlanCatalogError, SubscriptionAssignmentError, QuotaReservationError, ResourceChargeError): `invalid` → 400 (with `issues`), `not_found` → 404, `conflict` / `referenced` / `pending_payment` / `inactive` / `in_progress` → 409, `unavailable` → 503, with the body `{ statusCode, message, code, reason, issues?, details? }`. Every other error — including a third-party error that merely has a `reason` property — propagates.

| Factory | Routes | Permissions | Port |
| --- | --- | --- | --- |
| `createPlanAdminController({ service })` | `GET/POST /management/plans`, `GET/PUT/DELETE /:id`, `PATCH /:id/status {status}` | `plans:query/add/update/delete` | `PlanAdminPort` — `PlanCatalogService` from payment satisfies it |
| `createUserSubscriptionAdminController({ service })` | `GET /management/subscriptions?userId&status&active&planSlug&page&pageSize`, `GET/PUT/DELETE /:userId` | `subscriptions:query/update` | `UserSubscriptionAdminPort` (host composes `SubscriptionAssignmentService`, user summary and quota snapshots) |
| `createQuotaAdminControllers({ reservations })` | `GET /management/quota-usage?userId&counter&period`; `GET /management/quota-reservations?userId&counter&status&resourceType`, `GET /:id`, `POST /:id/release {reason?}`, `POST /:id/confirm` | `quota:query/update` | `QuotaReservationAdminPort` — `QuotaReservationService` from credit satisfies it |
| `createMailLogAdminController()` | `GET /management/email-logs?to&status&template&userId` | `mail:query` | `MailHistoryService` |

Plan writes (`SubscriptionPlanWriteBody`: `prices[]`, optional `expectedRevision`) are validated by the port (features/quotas against the host's entitlement catalog, price list, slug and provider-reference uniqueness); deletion is refused while a subscription, payment or open billing record references the plan. Subscription assignment validates the body (`planSlug`, `billingCycle` MONTHLY/YEARLY/ONE_TIME/LIFETIME, `status` ACTIVE/CANCELED/EXPIRED, ISO `startDate`/`endDate`) and passes the acting administrator ID; the port refuses changes while a plan payment is pending or a provider subscription controls the term (409 with `details.blocking`). The list filter `active=active|inactive` uses the derived validity (expiry is not swept into the stored status). Quota lists use the default projections `DEFAULT_QUOTA_USAGE_PROJECTION` / `DEFAULT_QUOTA_RESERVATION_PROJECTION` (response `userId` ← `subjectId`; internal policy metadata omitted). Release/confirm go through the reservation state machine and return `{ id, changed }`; confirming charges usage and releasing a live job's reservation makes that job's later confirmation fail as inactive. Mail log rows exclude provider metadata (`MAIL_LOG_FIELDS`). Use `createMailTemplateAdminController` with `mail:query` / `mail:update` for `/management/email-templates`.
