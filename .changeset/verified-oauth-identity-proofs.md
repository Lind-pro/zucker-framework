---
"@zucker-framework/auth": patch
---

Add server-side Google ID-token verification with bounded JWKS caching and rotation, plus one-time OAuth login/linking proofs composed from existing ticket primitives. Reject browser-supplied third-party profiles at the generic binding endpoint: consumers must configure a verified binding-proof resolver or keep their own authenticated binding controller. Preserve the trusted low-level binding API and consumer-owned admission, ownership and transaction policies.
