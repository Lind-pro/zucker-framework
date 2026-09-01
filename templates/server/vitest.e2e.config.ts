import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for NestJS API e2e tests.
 *
 * Uses SWC with `decoratorMetadata: true` so NestJS DI can resolve constructor
 * parameter types at runtime (TypeScript `emitDecoratorMetadata` equivalent).
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: {
          syntax: 'typescript',
          decorators: true,
        },
        transform: {
          legacyDecorator: true,
          decoratorMetadata: true,
        },
        target: 'es2022',
      },
    }),
  ],
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['./test/helpers/e2e-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    singleFork: true,
  },
});
