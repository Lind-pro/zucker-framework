---
"@zucker-framework/search": minor
---

Extend the existing SearchService with explicit connection ownership, optional startup health and alias provisioning, plugin discovery, timestamped index creation and guarded alias switching. Add a lazy Elasticsearch 9 adapter while preserving legacy SearchClient injection and request APIs. Consumers retain index schemas, analyzer selection, queries and retirement policy; the optional Elasticsearch peer is externalized. Regression source is included; real adapter acceptance remains required before release.
