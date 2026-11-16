import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import base from '../../../vitest.config.ts';

const httpRequire = createRequire(new URL('../../../packages/fe-http-client/package.json', import.meta.url));
const i18nRequire = createRequire(new URL('../../../packages/i18n/package.json', import.meta.url));

export default defineConfig({
  ...base,
  resolve: {
    ...base.resolve,
    alias: [
      ...(base.resolve?.alias as Array<{ find: RegExp; replacement: string }>),
      { find: /^axios$/, replacement: httpRequire.resolve('axios') },
      { find: /^rxjs$/, replacement: i18nRequire.resolve('rxjs') },
    ],
  },
  test: {
    ...base.test,
    include: ['docs/reviews/2026-11-16-package-review/reproduce.spec.ts'],
  },
});
