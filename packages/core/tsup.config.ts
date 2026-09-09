import { defineConfig } from 'tsup';

// @paralleldrive/cuid2 v3 is ESM-only. The framework also publishes a CJS
// entry for NestJS applications, so leaving cuid2 external would emit a
// runtime `require('@paralleldrive/cuid2')` that Node cannot load.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: false,
  clean: true,
  noExternal: ['@paralleldrive/cuid2'],
});
