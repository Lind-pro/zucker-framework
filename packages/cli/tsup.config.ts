export default {
  // Preserve the installed `zucker` bin at dist/index.js while keeping library imports inert.
  entry: { index: 'src/bin.ts', tooling: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  external: ['typescript'],
};
