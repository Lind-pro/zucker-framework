---
"@zucker-framework/notification": minor
---

Add AlertNotificationService using the existing notification deduplication and Webhook transport. Provide DingTalk, WeCom, Slack and generic JSON alert envelopes, acknowledgement validation, delivery outcomes and shutdown draining. Make Webhook URLs absent from success logs because they may contain credentials. Fix zero-timestamp deduplication and expose cache size without another consumer cleanup timer. Destination/severity/fingerprint/redaction policy remains host configuration.
