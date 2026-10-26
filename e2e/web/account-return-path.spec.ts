import { test, expect } from '@playwright/test';
import { accountReturnPath } from '../../templates/web/src/app/[locale]/account/_components/account-flow';

for (const [input, expected] of [
  [null, '/account'], ['', '/account'], ['/dashboard', '/dashboard'],
  ['/content/manage', '/content/manage'], ['/en/content/manage?page=2', '/content/manage?page=2'],
  ['/zh/content/manage/entry-1?tab=body#ignored', '/content/manage/entry-1?tab=body'],
  ['/billing/subscriptions/local-order', '/billing/subscriptions/local-order'],
  ['/en/billing/subscriptions/local-order?page=2', '/billing/subscriptions/local-order?page=2'],
  ['/content/managed', '/account'], ['/content/public', '/account'], ['/fr/content/manage', '/account'],
  ['https://evil.invalid/content/manage', '/account'], ['//evil.invalid/content/manage', '/account'],
  ['/content/manage/%2f%2fevil.invalid', '/account'], ['/content/manage/%252f%252fevil.invalid', '/account'],
  ['/content/manage/../public', '/account'], ['/content/manage/%2e%2e/public', '/account'],
  ['/en/content/manage/entry%5c..%5cpublic', '/account'], ['/en/content/manage/entry%0d%0aLocation:evil', '/account'],
  ['/billing/subscriptions/%252f%252fevil.invalid', '/account'], ['/account/security?tab=password', '/account/security?tab=password'],
]) {
  test(`protected account return path normalizes ${input}`, () => expect(accountReturnPath(input)).toBe(expected));
}
