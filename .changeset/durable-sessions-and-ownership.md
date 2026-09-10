---
"@zucker-framework/auth": minor
---

Add persistent database-backed sessions with atomic refresh rotation and revocation, optional deny-only caching, and configurable HttpOnly refresh-cookie transport. Add a required ownership guard for JWT request.user consumers, reuse the existing OwnCreated handler with explicit grant fallback, and check ownership for detail reads instead of relying on collection filters.
