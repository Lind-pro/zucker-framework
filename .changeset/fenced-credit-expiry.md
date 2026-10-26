---
"@zucker-framework/credit": patch
---

Expose transaction-bound expiry of selected owned credit lots so a host can fence expiry and its canonical journal with the task completion transaction. Existing expiry scanning reuses the same mechanism, including lots whose deadline equals the scan time.
