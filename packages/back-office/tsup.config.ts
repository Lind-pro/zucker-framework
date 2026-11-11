import { defineConfig } from 'tsup';

// One entry per public subpath (package.json "exports"); each host lives in src/<host>/ and is
// re-exported by src/<host>.ts. NestJS and every sibling framework package stay external so the
// consumer keeps a single runtime instance of each (DI tokens, guards, exception classes).
// The package script empties dist first, so stale entries from an older layout cannot be packed.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    accounts: 'src/accounts.ts',
    subscriptions: 'src/subscriptions.ts',
    billing: 'src/billing.ts',
    management: 'src/management.ts',
    mail: 'src/mail.ts',
    settings: 'src/settings.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: false,
  clean: false,
  target: 'es2022',
  external: [/^@nestjs\//, /^@zucker-framework\//, 'rxjs', 'reflect-metadata'],
});
