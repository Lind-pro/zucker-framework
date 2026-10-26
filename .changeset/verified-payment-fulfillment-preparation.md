---
'@zucker-framework/payment': patch
---

Add optional verified-payment preparation before hosted-checkout fulfillment transactions, allowing consumers to retrieve and persist refund evidence without performing provider I/O under ledger locks. Fulfillment adapters must still enforce persisted restrictions in the delivery transaction.
