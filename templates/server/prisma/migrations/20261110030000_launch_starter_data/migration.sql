-- WP 1.Z (Phase 1 integration): durable markers for one-time starter seeds (credit packs are seeded once, never re-created
-- after an administrator deletes them). Additive only.
CREATE TABLE "starter_data_markers" (
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "starter_data_markers_pkey" PRIMARY KEY ("name")
);

-- Installations that already hold credit packs were seeded (or curated) before markers existed.
INSERT INTO "starter_data_markers" ("name")
SELECT 'credit-packs' WHERE EXISTS (SELECT 1 FROM "credit_packs");

-- Upgraded installations get the Phase 1 starter menus (credit packs, product policies) the same way
-- 20261109000000_back_office added its menus: only under a starter group that still exists, existing
-- rows and names untouched. Keep in sync with starterAdminMenus.
INSERT INTO "permissions" ("id","name","description")
SELECT code, code, 'Seeded with the starter back office'
FROM unnest(ARRAY['config:query']) AS code
WHERE EXISTS (SELECT 1 FROM "menus" WHERE "id" = 'starter:system')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "menus" ("id","name","path","parentId","permissions","sortOrder","status")
SELECT m.id, m.name, m.path, m.parent, ARRAY[m.permission], m.sort, true
FROM (VALUES
  ('starter:credit-packs', '积分包', '/credit-packs', 'starter:commerce', 'plans:query', 13),
  ('starter:policies', '产品策略', '/policies', 'starter:system', 'config:query', 31)
) AS m(id, name, path, parent, permission, sort)
WHERE EXISTS (SELECT 1 FROM "menus" parent WHERE parent."id" = m.parent)
ON CONFLICT ("id") DO NOTHING;
