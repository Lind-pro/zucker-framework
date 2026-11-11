-- WP 3.Z (Phase 3 integration).
--
-- 1. Referral bindings: the database refuses a mutual binding (A referred by B while B is referred by A),
--    as the service does. A CHECK cannot see other rows, and an expression unique index is not
--    representable in the Prisma schema, so this is a trigger. The transaction-scoped advisory lock on
--    the unordered pair serialises two concurrent opposite inserts, so both cannot pass the check.
CREATE OR REPLACE FUNCTION referral_bindings_refuse_mutual() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutual boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('referral-pair:' || LEAST(NEW."refereeId", NEW."referrerId")
    || ':' || GREATEST(NEW."refereeId", NEW."referrerId"), 0));
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.referral_bindings WHERE "refereeId" = $1 AND "referrerId" = $2)', TG_TABLE_SCHEMA)
    INTO mutual USING NEW."referrerId", NEW."refereeId";
  IF mutual THEN
    RAISE EXCEPTION 'mutual referral binding refused' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS referral_bindings_refuse_mutual ON "referral_bindings";
CREATE TRIGGER referral_bindings_refuse_mutual BEFORE INSERT OR UPDATE OF "refereeId", "referrerId" ON "referral_bindings"
  FOR EACH ROW EXECUTE FUNCTION referral_bindings_refuse_mutual();

-- 2. Back-office permissions and menus of the Phase 3 features for upgraded installations, the same
--    way 20261110060000_ai_back_office did: only on a database the starter setup already seeded
--    (the starter:system group exists); existing rows and names are untouched. A fresh database is
--    left to the administrator setup command. Keep in sync with starterAdminMenus and
--    BACK_OFFICE_PERMISSIONS (create-administrator.ts).
INSERT INTO "permissions" ("id","name","description")
SELECT code, code, 'Seeded with the starter back office'
FROM unnest(ARRAY['feedback:query','feedback:update','promotions:query','promotions:create','promotions:update',
  'promotions:delete','referrals:query','referrals:update','insights:query']) AS code
WHERE EXISTS (SELECT 1 FROM "menus" WHERE "id" = 'starter:system')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "menus" ("id","name","path","parentId","permissions","sortOrder","status")
SELECT 'starter:insights', '运营洞察', '/insights', NULL, ARRAY['insights:query']::TEXT[], 1, true
WHERE EXISTS (SELECT 1 FROM "menus" WHERE "id" = 'starter:system')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "menus" ("id","name","path","parentId","permissions","sortOrder","status")
SELECT m.id, m.name, m.path, m.parent, ARRAY[m.permission], m.sort, true
FROM (VALUES
  ('starter:promotions', '优惠码', '/promotions', 'starter:commerce', 'promotions:query', 21),
  ('starter:referrals', '邀请返利', '/referrals', 'starter:commerce', 'referrals:query', 22),
  ('starter:feedback', '用户反馈', '/feedback', 'starter:operations', 'feedback:query', 28)
) AS m(id, name, path, parent, permission, sort)
WHERE EXISTS (SELECT 1 FROM "menus" parent WHERE parent."id" = m.parent)
ON CONFLICT ("id") DO NOTHING;
