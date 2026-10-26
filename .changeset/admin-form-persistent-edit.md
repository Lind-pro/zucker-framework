---
"@zucker-framework/admin": patch
---

Connect the default form manager's create and edit actions to persistent form definitions. Supply
missing identity/empty fields on creation, expose the permission-protected PUT route, reject invalid
field shapes and map missing/unique records without treating failed writes as success.
