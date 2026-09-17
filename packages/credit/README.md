
### Revoke unused lots

`BatchCreditLedger.revokeUnused(tx, { accountId, lotIds, transactionData })` removes only the
remaining value of the selected lots under the existing account lock, updates the cached balance
and appends one journal entry on the supplied transaction. Repeating the command returns zero.
The caller owns lot selection and refund/entitlement policy; consumed allocations remain intact.
