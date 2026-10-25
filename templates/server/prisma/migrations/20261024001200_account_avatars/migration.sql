ALTER TABLE "users" ADD COLUMN "avatarFileId" TEXT, ADD COLUMN "avatarRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_revision_check" CHECK ("avatarRevision">=0);
ALTER TABLE "users" ADD CONSTRAINT "users_avatarFileId_fkey" FOREIGN KEY ("avatarFileId") REFERENCES "file_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "account_avatar_changes" (
  "id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "idempotencyKey" TEXT NOT NULL,
  "action" TEXT NOT NULL CHECK ("action" IN ('UPLOAD','REMOVE')), "assetId" TEXT,
  "expectedRevision" INTEGER NOT NULL CHECK ("expectedRevision">=0), "appliedRevision" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_avatar_changes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "account_avatar_changes_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "file_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ("appliedRevision"::bigint="expectedRevision"::bigint+1),
  CHECK (("action"='UPLOAD' AND "assetId" IS NOT NULL) OR ("action"='REMOVE' AND "assetId" IS NULL))
);
CREATE UNIQUE INDEX "account_avatar_changes_userId_idempotencyKey_key" ON "account_avatar_changes"("userId","idempotencyKey");
CREATE INDEX "account_avatar_changes_userId_createdAt_idx" ON "account_avatar_changes"("userId","createdAt");
CREATE FUNCTION enforce_avatar_change_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Avatar request receipts are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER avatar_change_identity BEFORE UPDATE ON "account_avatar_changes" FOR EACH ROW EXECUTE FUNCTION enforce_avatar_change_identity();
