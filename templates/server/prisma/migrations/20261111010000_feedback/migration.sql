-- WP 3.1: user feedback with a staff reply (models/feedback.prisma).
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "pagePath" TEXT,
    "locale" TEXT,
    "userAgent" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reply" TEXT,
    "staffNote" TEXT,
    "handledBy" TEXT,
    "repliedAt" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "feedback_type_check" CHECK ("type" IN ('bug', 'idea', 'question', 'other')),
    CONSTRAINT "feedback_status_check" CHECK ("status" IN ('open', 'in_progress', 'resolved', 'closed')),
    CONSTRAINT "feedback_lengths_check" CHECK (char_length("message") BETWEEN 1 AND 4000
        AND char_length("requestKey") BETWEEN 8 AND 128
        AND ("pagePath" IS NULL OR char_length("pagePath") <= 512)
        AND ("locale" IS NULL OR char_length("locale") <= 35)
        AND ("userAgent" IS NULL OR char_length("userAgent") <= 256)
        AND ("reply" IS NULL OR char_length("reply") <= 2000)
        AND ("staffNote" IS NULL OR char_length("staffNote") <= 2000)),
    CONSTRAINT "feedback_revision_check" CHECK ("revision" >= 0)
);

CREATE UNIQUE INDEX "feedback_owner_request_key" ON "feedback"("ownerId", "requestKey");
CREATE INDEX "feedback_owner_created_idx" ON "feedback"("ownerId", "createdAt" DESC, "id" DESC);
CREATE INDEX "feedback_status_created_idx" ON "feedback"("status", "createdAt" DESC, "id" DESC);
