-- WP 2.6: content-addressed public raster images. Additive; existing tables are unchanged.
CREATE TABLE "public_assets" (
  "sha256" CHAR(64) NOT NULL,
  "ownerId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "public_assets_pkey" PRIMARY KEY ("sha256"),
  CONSTRAINT "public_assets_hash_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "public_assets_size_check" CHECK ("size" > 0),
  CONSTRAINT "public_assets_dimensions_check" CHECK ("width" > 0 AND "height" > 0),
  CONSTRAINT "public_assets_mime_check" CHECK ("mimeType" IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  CONSTRAINT "public_assets_state_check" CHECK ("state" IN ('pending', 'ready')),
  -- Only the content-addressed public prefix; a row can never point at a private object.
  CONSTRAINT "public_assets_key_check" CHECK ("objectKey" = 'public-assets/' || "sha256" || '.' || CASE "mimeType"
    WHEN 'image/png' THEN 'png' WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/webp' THEN 'webp' ELSE 'gif' END)
);
CREATE UNIQUE INDEX "public_assets_objectKey_key" ON "public_assets"("objectKey");
CREATE INDEX "public_assets_ownerId_createdAt_idx" ON "public_assets"("ownerId", "createdAt");

CREATE FUNCTION enforce_public_asset_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."sha256", NEW."ownerId", NEW."objectKey", NEW."size", NEW."mimeType", NEW."width", NEW."height", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."sha256", OLD."ownerId", OLD."objectKey", OLD."size", OLD."mimeType", OLD."width", OLD."height", OLD."createdAt") THEN
    RAISE EXCEPTION 'Public asset identity is immutable';
  END IF;
  IF OLD."state" = 'ready' AND NEW."state" <> 'ready' THEN
    RAISE EXCEPTION 'Ready public assets cannot return to pending';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER public_asset_identity BEFORE UPDATE ON "public_assets"
FOR EACH ROW EXECUTE FUNCTION enforce_public_asset_identity();
