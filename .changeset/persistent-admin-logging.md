---
"@zucker-framework/logging": minor
---

Add database-backed access and operation log services for paginated queries, statistics, timelines, bounded deletion, retention and CSV export. Root configuration reuses the host database adapter and explicitly configures privacy policy, client-IP retention and persistence. The shared interceptor persists both log kinds without changing application success/failure semantics and preserves structured HTTP error messages.
