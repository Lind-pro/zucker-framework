/** Reference DDL for a consumer-owned versioned migration; never executed by the package. */
export const notificationDeliverySchemaSql = `
CREATE TABLE notification_deliveries (
  "id" text PRIMARY KEY,
  "idempotencyKey" text NOT NULL UNIQUE,
  "idempotencyFingerprint" text NOT NULL,
  "channel" text NOT NULL,
  "deliveryRef" text NOT NULL,
  "priority" double precision NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','PROCESSING','RETRYING','DELIVERED','DEAD')),
  "attempt" integer NOT NULL DEFAULT 0 CHECK ("attempt">=0),
  "maxAttempts" integer NOT NULL CHECK ("maxAttempts">0),
  "availableAt" timestamptz(3) NOT NULL DEFAULT now(),
  "workerId" text,
  "leaseToken" text,
  "leaseExpiresAt" timestamptz(3),
  "providerMessageId" text,
  "errorCode" text,
  "errorRetryable" boolean,
  "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
  "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
  "deliveredAt" timestamptz(3),
  "failedAt" timestamptz(3),
  "version" integer NOT NULL DEFAULT 0,
  CHECK (("status"='PROCESSING' AND "workerId" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
    OR ("status"<>'PROCESSING' AND "workerId" IS NULL AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL))
);
CREATE INDEX notification_deliveries_ready_idx ON notification_deliveries ("status", "availableAt", "priority");
CREATE INDEX notification_deliveries_lease_idx ON notification_deliveries ("status", "leaseExpiresAt");
`;
