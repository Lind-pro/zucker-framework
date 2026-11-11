-- Plan-order refunds (back-office billing host, F4): a plan purchase grants entitlement, not
-- credits, and is refunded by paid amount. Its refund payment row therefore carries
-- "totalCredits" = 0. Expand-only: the check is widened from > 0 to >= 0; existing rows already satisfy it.
ALTER TABLE "billing_refund_payments" DROP CONSTRAINT IF EXISTS "billing_refund_payments_totalCredits_check";
ALTER TABLE "billing_refund_payments" ADD CONSTRAINT "billing_refund_payments_totalCredits_check" CHECK ("totalCredits" >= 0);
