CREATE TABLE "file_assets" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "size" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  "cleanupStatus" TEXT,
  "cleanupConfirmedAt" TIMESTAMP(3),
  CONSTRAINT "file_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "file_assets_size_check" CHECK ("size" > 0),
  CONSTRAINT "file_assets_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "file_assets_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "file_assets_state_check" CHECK (
    ("state" IN ('pending', 'ready') AND "deletedAt" IS NULL AND "cleanupStatus" IS NULL AND "cleanupConfirmedAt" IS NULL)
    OR ("state" = 'deleted' AND "deletedAt" IS NOT NULL AND "cleanupStatus" IS NOT NULL AND (
      ("cleanupStatus" = 'pending' AND "cleanupConfirmedAt" IS NULL)
      OR ("cleanupStatus" = 'confirmed' AND "cleanupConfirmedAt" IS NOT NULL)
    ))
  )
);
CREATE UNIQUE INDEX "file_assets_objectKey_key" ON "file_assets"("objectKey");
CREATE UNIQUE INDEX "file_assets_ownerId_idempotencyKey_key" ON "file_assets"("ownerId", "idempotencyKey");
CREATE INDEX "file_assets_ownerId_createdAt_idx" ON "file_assets"("ownerId", "createdAt");
CREATE INDEX "file_assets_state_cleanupStatus_updatedAt_idx" ON "file_assets"("state", "cleanupStatus", "updatedAt");

CREATE FUNCTION enforce_file_asset_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."ownerId", NEW."idempotencyKey", NEW."objectKey", NEW."fileName", NEW."sha256", NEW."size", NEW."mimeType", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."id", OLD."ownerId", OLD."idempotencyKey", OLD."objectKey", OLD."fileName", OLD."sha256", OLD."size", OLD."mimeType", OLD."createdAt") THEN
    RAISE EXCEPTION 'File asset identity is immutable';
  END IF;
  IF OLD."state" = 'deleted' AND NEW."state" <> 'deleted' THEN
    RAISE EXCEPTION 'Deleted file assets cannot be restored';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'File asset updates require a new revision';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER file_asset_identity BEFORE UPDATE ON "file_assets"
FOR EACH ROW EXECUTE FUNCTION enforce_file_asset_identity();
