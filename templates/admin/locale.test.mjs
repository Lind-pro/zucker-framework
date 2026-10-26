import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminMenuName, visibleAdminMenus } from './src/config/admin-navigation.ts';
import { translateAdminText } from './src/i18n/messages.ts';

const menu = {
  id: 'starter:users',
  name: '用户',
  path: '/users',
  status: true,
  sortOrder: 1,
  permissions: ['users:query'],
};
test('localizes only unchanged starter menu identities and preserves consumer customizations', () => {
  assert.equal(adminMenuName(menu, 'en'), 'Users');
  assert.equal(adminMenuName(menu, 'zh'), '用户');
  assert.equal(adminMenuName({ ...menu, id: 'custom:users' }, 'en'), '用户');
  assert.equal(adminMenuName({ ...menu, name: '客户账户' }, 'en'), '客户账户');
  assert.equal(adminMenuName({ ...menu, path: '/roles' }, 'en'), '用户');
  assert.equal(menu.name, '用户');
});
test('language presentation does not change menu permission or route selection', () => {
  assert.deepEqual(
    visibleAdminMenus([menu], () => false),
    [],
  );
  const allowed = visibleAdminMenus([menu], (permission) => permission === 'users:query');
  assert.equal(allowed[0].id, menu.id);
  assert.equal(allowed[0].path, '/users');
  assert.equal(adminMenuName(allowed[0], 'en'), 'Users');
  assert.deepEqual(allowed[0].permissions, ['users:query']);
});
test('handles interpolated UI messages without treating unknown resource text as prototype entries', () => {
  assert.equal(
    translateAdminText('en', '删除 {count} 条', 'Delete {count} records', { count: 3 }),
    'Delete 3 records',
  );
  assert.equal(
    translateAdminText('zh', '删除 {count} 条', 'Delete {count} records', { count: 3 }),
    '删除 3 条',
  );
  assert.equal(translateAdminText('en', 'constructor'), 'constructor');
  assert.equal(translateAdminText('en', '自定义内容'), '自定义内容');
});
