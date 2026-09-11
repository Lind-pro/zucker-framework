---
"@zucker-framework/crud": minor
---

Add CrudEntity and an undecorated CrudService for services with custom Nest constructor layouts. Existing BaseService injection remains supported, and both entries share the same CRUD implementation. Allow BaseController consumers to select routes, configure HTTP methods/paths and decorators, and supply a validated query DTO. Single-record upsert is opt-in. This removes consumer-side metadata overrides without expanding their HTTP surface.
