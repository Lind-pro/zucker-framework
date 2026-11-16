import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

/** Real Web modules/components against synthetic transports; never starts Next or calls providers. */
export default defineConfig({
  ...base,
  resolve: {
    ...base.resolve,
    alias: [
      ...(base.resolve?.alias as Array<{ find: RegExp; replacement: string }>),
      { find: '@', replacement: resolve(import.meta.dirname, 'templates/web/src') },
    ],
  },
  test: {
    ...base.test,
    include: ['templates/web/test/**/*.spec.{ts,tsx}'],
  },
});
