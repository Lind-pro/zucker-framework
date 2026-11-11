-- WP 3.2: in-app notifications. Rows are recipient-scoped and idempotent per (userId, eventKey);
-- text is rendered by the web app from `type` + `params`, so no free text is stored here.
CREATE TABLE "inbox_notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventKey" VARCHAR(200) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "href" VARCHAR(512),
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMPTZ(3),
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_notifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inbox_notifications_type_check" CHECK ("type" ~ '^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$'),
    CONSTRAINT "inbox_notifications_event_key_check" CHECK (length("eventKey") BETWEEN 1 AND 200),
    CONSTRAINT "inbox_notifications_params_check" CHECK (jsonb_typeof("params") = 'object' AND octet_length("params"::text) <= 2048),
    CONSTRAINT "inbox_notifications_href_check" CHECK ("href" IS NULL OR ("href" LIKE '/%' AND "href" NOT LIKE '//%' AND strpos("href", E'\\') = 0)),
    CONSTRAINT "inbox_notifications_read_check" CHECK ("isRead" = ("readAt" IS NOT NULL))
);

CREATE TABLE "inbox_cursors" (
    "source" VARCHAR(64) NOT NULL,
    "cursorAt" TIMESTAMPTZ(3) NOT NULL,
    "cursorId" VARCHAR(200) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_cursors_pkey" PRIMARY KEY ("source")
);

CREATE UNIQUE INDEX "inbox_notifications_user_event_key" ON "inbox_notifications"("userId", "eventKey");
CREATE INDEX "inbox_notifications_recipient_idx" ON "inbox_notifications"("userId", "isArchived", "isRead", "createdAt" DESC);
CREATE INDEX "inbox_notifications_retention_idx" ON "inbox_notifications"("isRead", "createdAt");
