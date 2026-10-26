---
'@zucker-framework/config': patch
---

Keep encrypted configuration values out of history and change events; mark protected events for trusted reloads, fail closed without encryption or on decryption errors, and refuse history-based credential restoration. Publish batch cache changes only after a successful transaction. Existing plaintext history is masked on reads but is not automatically rewritten.
