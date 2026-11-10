-- WP 2.Z (Phase 2 integration): upgraded installations get the AI back-office permissions and menus the
-- same way 20261110030000_launch_starter_data added its menus: only on a database the starter setup
-- already seeded (the starter:system group exists), existing rows and names untouched. A fresh
-- database is left to the administrator setup command. Keep in sync with starterAdminMenus.
INSERT INTO "permissions" ("id","name","description")
SELECT code, code, 'Seeded with the starter back office'
FROM unnest(ARRAY['ai-tasks:query','chats:query']) AS code
WHERE EXISTS (SELECT 1 FROM "menus" WHERE "id" = 'starter:system')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "menus" ("id","name","path","parentId","permissions","sortOrder","status")
SELECT 'starter:ai', 'AI', NULL, NULL, ARRAY[]::TEXT[], 19, true
WHERE EXISTS (SELECT 1 FROM "menus" WHERE "id" = 'starter:system')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "menus" ("id","name","path","parentId","permissions","sortOrder","status")
SELECT m.id, m.name, m.path, m.parent, ARRAY[m.permission], m.sort, true
FROM (VALUES
  ('starter:ai-tasks', '生成任务', '/ai/tasks', 'starter:ai', 'ai-tasks:query', 20),
  ('starter:ai-chats', 'AI 对话', '/ai/chats', 'starter:ai', 'chats:query', 21),
  ('starter:ai-pricing', '模型与定价', '/ai/pricing', 'starter:ai', 'config:update', 22)
) AS m(id, name, path, parent, permission, sort)
WHERE EXISTS (SELECT 1 FROM "menus" parent WHERE parent."id" = m.parent)
ON CONFLICT ("id") DO NOTHING;
