import { defineConfig, type Options } from 'tsup';

// Every runtime dependency and peer stays external, so the consumer keeps one React, router,
// Zustand store implementation, icon set and one copy of each sibling framework package. Listed
// explicitly (tsup would also infer them from package.json) so a config edit cannot start bundling
// them; scripts/verify-package-artifacts.mjs checks the output.
const external = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-router',
  'react-router/dom',
  'zustand',
  'lucide-react',
  'radix-ui',
  'sonner',
  'clsx',
  'tailwind-merge',
  /^@zucker-framework\//,
];

// The two builds run concurrently, so neither cleans: the package script empties dist first.
const shared: Options = {
  entry: ['src/index.ts'],
  clean: false,
  target: 'es2022',
  external,
};

export default defineConfig([
  // ESM: built-in pages and non-default locale copy are split into chunks loaded on demand.
  { ...shared, format: ['esm'], splitting: true, dts: true },
  // CJS stays a single file (tsup's CJS splitting is experimental); dynamic imports become requires.
  { ...shared, format: ['cjs'], splitting: false, dts: true },
]);
