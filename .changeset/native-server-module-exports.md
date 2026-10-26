---
"@zucker-framework/admin": patch
"@zucker-framework/config": patch
"@zucker-framework/dictionary": patch
"@zucker-framework/cache": patch
"@zucker-framework/credit": patch
"@zucker-framework/logging": patch
"@zucker-framework/form": patch
"@zucker-framework/provider": patch
"@zucker-framework/monitoring": patch
"@zucker-framework/reference": patch
"@zucker-framework/script": patch
"@zucker-framework/rule-engine": patch
"@zucker-framework/storage": patch
"@zucker-framework/rate-limiter": patch
"@zucker-framework/queue": patch
---

Route public package-root imports and requires to the existing matching ESM/CJS runtime and type artifacts. Previously, native ESM imports of these packages fell back to their CommonJS main entry, mixing auth/core provider classes with an application's ESM instances and breaking Nest dependency injection. Keep package.json metadata readable and preserve the existing main/module artifacts.

Add a native Node regression for both module formats that checks package resolution, shared auth/guard identity and an Admin/Nest composition using a synthetic memory adapter. This does not make mixed import/require copies of a dual package interchangeable and does not replace persistent consumer validation. No service implementation, guard registration or access policy is relaxed.

Use the CommonJS default export for eventemitter2 in config, dictionary and logging, with an explicit injection token referencing the original constructor. This fixes native ESM loading while retaining the shared Nest event emitter; no dependency is bundled or duplicated.
