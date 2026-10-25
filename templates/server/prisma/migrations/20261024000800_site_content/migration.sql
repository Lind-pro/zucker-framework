CREATE TABLE "site_content_entries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "draft" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "publishedSlug" TEXT,
  "published" JSONB,
  "publishedTitle" TEXT,
  "publishedDescription" TEXT,
  "searchText" TEXT NOT NULL DEFAULT '',
  "publishedAt" TIMESTAMP(3),
  "publishedRevision" INTEGER,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_content_entries_kind_check" CHECK ("kind" IN ('page','post','doc')),
  CONSTRAINT "site_content_entries_locale_check" CHECK ("locale" IN ('zh','en')),
  CONSTRAINT "site_content_entries_slug_check" CHECK (length("slug") BETWEEN 1 AND 200 AND "slug" ~ '^[a-z0-9]+([/-][a-z0-9]+)*$'),
  CONSTRAINT "site_content_entries_draft_check" CHECK (jsonb_typeof("draft") = 'object'),
  CONSTRAINT "site_content_entries_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "site_content_entries_publication_check" CHECK (
    ("status" = 'published' AND "published" IS NOT NULL AND jsonb_typeof("published") = 'object'
      AND "publishedSlug" IS NOT NULL AND "publishedTitle" IS NOT NULL AND "publishedDescription" IS NOT NULL
      AND "publishedAt" IS NOT NULL AND "publishedRevision" IS NOT NULL AND "publishedRevision" BETWEEN 0 AND "revision")
    OR ("status" IN ('draft','archived') AND "published" IS NULL AND "publishedSlug" IS NULL
      AND "publishedTitle" IS NULL AND "publishedDescription" IS NULL AND "publishedAt" IS NULL
      AND "publishedRevision" IS NULL AND "searchText" = '')
  )
);
CREATE UNIQUE INDEX "site_content_entries_kind_locale_slug_key" ON "site_content_entries"("kind","locale","slug");
CREATE UNIQUE INDEX "site_content_entries_kind_locale_publishedSlug_key" ON "site_content_entries"("kind","locale","publishedSlug");
CREATE INDEX "site_content_entries_kind_locale_status_publishedAt_id_idx" ON "site_content_entries"("kind","locale","status","publishedAt","id");
CREATE INDEX "site_content_entries_search_idx" ON "site_content_entries" USING GIN (to_tsvector('simple', "searchText")) WHERE "status" = 'published';
CREATE INDEX "site_content_entries_categories_idx" ON "site_content_entries" USING GIN (("published" -> 'categoryIds')) WHERE "status" = 'published';

CREATE TABLE "site_content_categories" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "locale" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "draft" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "publishedSlug" TEXT,
  "published" JSONB,
  "publishedAt" TIMESTAMP(3),
  "publishedRevision" INTEGER,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_content_categories_locale_check" CHECK ("locale" IN ('zh','en')),
  CONSTRAINT "site_content_categories_slug_check" CHECK (length("slug") BETWEEN 1 AND 100 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "site_content_categories_draft_check" CHECK (jsonb_typeof("draft") = 'object'),
  CONSTRAINT "site_content_categories_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "site_content_categories_publication_check" CHECK (
    ("status" = 'published' AND "published" IS NOT NULL AND jsonb_typeof("published") = 'object'
      AND "publishedSlug" IS NOT NULL AND "publishedAt" IS NOT NULL AND "publishedRevision" IS NOT NULL
      AND "publishedRevision" BETWEEN 0 AND "revision")
    OR ("status" IN ('draft','archived') AND "published" IS NULL AND "publishedSlug" IS NULL
      AND "publishedAt" IS NULL AND "publishedRevision" IS NULL)
  )
);
CREATE UNIQUE INDEX "site_content_categories_locale_slug_key" ON "site_content_categories"("locale","slug");
CREATE UNIQUE INDEX "site_content_categories_locale_publishedSlug_key" ON "site_content_categories"("locale","publishedSlug");
CREATE INDEX "site_content_categories_locale_status_publishedAt_id_idx" ON "site_content_categories"("locale","status","publishedAt","id");

CREATE FUNCTION enforce_site_content_entry_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."kind",NEW."locale",NEW."createdBy",NEW."createdAt") IS DISTINCT FROM
     ROW(OLD."id",OLD."kind",OLD."locale",OLD."createdBy",OLD."createdAt") THEN
    RAISE EXCEPTION 'Content identity and authorship are immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN RAISE EXCEPTION 'Content changes require a new revision'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER site_content_entry_identity BEFORE UPDATE ON "site_content_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_site_content_entry_identity();

CREATE FUNCTION enforce_site_content_category_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."locale",NEW."createdBy",NEW."createdAt") IS DISTINCT FROM
     ROW(OLD."id",OLD."locale",OLD."createdBy",OLD."createdAt") THEN
    RAISE EXCEPTION 'Category identity and authorship are immutable';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN RAISE EXCEPTION 'Category changes require a new revision'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER site_content_category_identity BEFORE UPDATE ON "site_content_categories"
FOR EACH ROW EXECUTE FUNCTION enforce_site_content_category_identity();
