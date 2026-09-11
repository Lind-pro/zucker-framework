---
"@zucker-framework/core": minor
"@zucker-framework/auth": minor
---

Add SecretCipher for AES-256-GCM/scrypt encrypted fields with explicit key material, stable v2 encoding and opt-in read-only legacy CBC support. Require full GCM authentication tags and reject malformed/plaintext stored values. Add ScryptEncoder implementing PasswordEncoder while preserving the two-part hex salt/derived-key format. Application environment, key selection and accepted historical formats remain consumer configuration; no data rewrite or password reset is required for valid existing records.
