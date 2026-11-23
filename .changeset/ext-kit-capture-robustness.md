---
"@zucker-framework/ext-kit": patch
---

Capture no longer hangs or fails on several common page conditions:

- A stylesheet that never loads blocked painting, so the screenshot waited forever and stalled the batch. Hung subresources are now stopped after the load grace period, and screenshot/PDF commands are bounded by a timeout.
- Chromium's transient "Unable to capture screenshot" is retried.
- Clocks, tickers and rotating banners that keep changing without adding content are treated as settled after 3 seconds instead of failing as "still changing".
- Verification waits probe pages whose load never completes, and auto-scroll stops on pages that cannot scroll.
