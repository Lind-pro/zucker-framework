---
"@zucker-framework/cli": minor
---

Allow module-wiring consumers to declare expected named APP_GUARD factories separately from class registrations. Imported aliases resolve to the original symbol, and missing, duplicate, unknown or wrong-owner factory registrations remain errors. The audit checks registration identity without pretending to infer a factory's returned guard class.
