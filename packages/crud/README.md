# CRUD

## Services with custom dependency injection

Extend `CrudService<T>` when your Nest service has a custom constructor. Inject the configured `DATABASE_ADAPTER` explicitly and pass it, `DynamicQueryService`, and the model name to `super`. `CrudService` has no inherited Nest parameter tokens, so product dependencies cannot accidentally resolve as a database adapter or event bus. `CrudEntity` requires an ID and permits optional timestamps; the host chooses the ordering field. Existing `BaseService<T>` retains its standard injected constructor and delegates to the same implementation.

`BaseController(Entity, options)` accepts `only` (enabled methods), `routes` (method/path overrides and additional decorators), and `queryDto` (the runtime query DTO used by Nest validation). Defaults preserve the existing Framework HTTP surface; single-record `saveOrUpdate` must be explicitly enabled. Pass application policy as a configuration object instead of mutating generated prototypes in consumers. Controller factories are isolated, so configuring one resource does not change another.

## Validated HTTP query DTO

`QueryParamDto` supplies transformation and validation for filters, orderBy, page (default 1), pageSize (default 10, maximum 100), and comma-separated includes/excludes. Non-string projection inputs remain subject to validation instead of throwing inside the transform. `QueryParamEntity` remains the query-builder API; it is not replaced by the transport DTO.
