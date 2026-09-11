/** Read-only provider evidence; unknown must never be treated as an instruction to charge. */
export type PaymentSettlementState = 'paid' | 'unpaid' | 'unknown';
