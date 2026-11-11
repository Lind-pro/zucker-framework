-- WP 3.6: write-ahead intents for server-generated objects, swept when no file row references them. Additive.
CREATE TABLE "file_object_intents" (
  "objectKey" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "file_object_intents_pkey" PRIMARY KEY ("objectKey"),
  CONSTRAINT "file_object_intents_kind_check" CHECK ("kind" IN ('generated', 'public-asset')),
  -- The sweeper deletes objects by these keys: only the server-owned prefixes are allowed.
  CONSTRAINT "file_object_intents_key_check" CHECK (
    ("kind" = 'generated' AND "objectKey" ~ '^private-assets/[0-9a-f-]{36}$')
    OR ("kind" = 'public-asset' AND "objectKey" ~ '^public-assets/[a-f0-9]{64}\.(png|jpg|webp|gif)$'))
);
CREATE INDEX "file_object_intents_createdAt_idx" ON "file_object_intents"("createdAt");
