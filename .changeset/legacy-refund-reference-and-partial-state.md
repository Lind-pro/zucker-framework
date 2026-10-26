---
"@zucker-framework/payment": patch
---

Preserve legacy paid order state after a successful partial refund and return a partial-refund observation instead of claiming the entire payment was refunded. Validate requested refund money before claiming the order. Resolve PayPal Orders v2 references to a unique refundable capture before calling the capture refund endpoint, preserving the existing PaymentSession reference contract.
