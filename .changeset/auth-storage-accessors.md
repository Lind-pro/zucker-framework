---
"@zucker-framework/fe-auth": patch
"@zucker-framework/fe-storage": patch
---

Use a storage adapter's typed auth setters when available, preserving generic key/value adapters. Synchronize hydrated sessions with the HTTP client's token storage and retain consumer hydration callbacks. Accept typed user profiles in LocalStore without requiring an index signature.
