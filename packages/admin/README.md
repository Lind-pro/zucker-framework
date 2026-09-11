# Admin APIs

The package provides optional feature modules and configurable controllers. Applications configure the database and authentication once at their composition root.

For persistent audit management, use `createAccessLogAdminController` and `createOperationLogAdminController` with the host's route, resource and audit labels. They use `AccessLogService` / `OperationLogService` configured by `ZuckerLoggingModule.forRoot({ persistence: ... })`. `createLogQueryController` adds the shared read, timeline, statistics, metrics and CSV endpoints; permission codes and export labels are host configuration. Existing default feature modules remain available for their documented contracts.

`createReadOnlyAdminController` exposes only `GET /` and `GET /:id` for a configured database model. Pagination executes in the database and is capped at 100 records by default. Only configured equality filters and the record ID are accepted. Both plain query parameters and the Framework frontend's `filters={"field$eq":"value"}` encoding are supported; arbitrary operators, fields and model names are not forwarded to storage. Business mutations such as credit or reservation transitions belong to their business APIs.

Controller factories use `JwtAuthGuard` and `PermissionsGuard` by default. Hosts with equivalent global guards can pass `guards: []`; route permission metadata remains present and is enforced by those global guards. Do not register unguarded generated controllers in an application without global authentication and authorization.

## Configured catalogs and AI models

`createCatalogAdminController` supplies a constrained REST catalog backed by the existing CRUD `BaseService`: configured list/detail relations and filters, bounded pagination, create/update field allowlists and soft deletion. Configure the resource, guards and `createAction` to preserve the application's persisted permission names. Route/model/schema policy remains host configuration; no unrestricted query or mutation routes are inherited.

`createAIModelAdminController` exposes the persistent `AIModelCatalogService` with configured read/read-secret/create/update/delete permissions. Register specialized host routes (such as subscription or runtime-cache administration) before its parameterized `:id` route. `createResendWebhookController` exposes signed mail callbacks; enable raw-body capture at Nest bootstrap and configure one `ResendWebhookService` with the host suppression policy. Bad signatures return 401, invalid payloads 400, and persistence failures 503 for provider retry.
