// @vitest-environment node
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('type-checks consumer billing path and permission overrides without widening their known keys', () => {
  const filename = fileURLToPath(new URL('./billing-options-consumer.ts', import.meta.url));
  const source = `import type { BackOfficeBillingOptions, ResolvedBillingOptions } from './billing.options';
    const paths: BackOfficeBillingOptions['paths'] = { billing: 'payments', subscriptions: 'payments/subscriptions' };
    const permissions: BackOfficeBillingOptions['permissions'] = { refund: 'payments:refund', recover: 'orders:recover' };
    const resolved: Pick<ResolvedBillingOptions, 'paths' | 'permissions'> = {
      paths: { billing: 'payments', subscriptions: 'payments/subscriptions', refunds: 'payments/refunds', recovery: 'orders',
        paymentCredentials: 'credentials', creditPacks: 'packs', testCheckout: 'payments/test' },
      permissions: { refund: 'payments:refund', recover: 'orders:recover', paymentCredentials: 'credentials:update' },
    };
    // @ts-expect-error unknown route keys remain invalid
    const unknownPath: BackOfficeBillingOptions['paths'] = { invented: 'payments' };
    // @ts-expect-error route values must remain strings
    const wrongPath: BackOfficeBillingOptions['paths'] = { billing: 123 };
    // @ts-expect-error unknown permission keys remain invalid
    const unknownPermission: BackOfficeBillingOptions['permissions'] = { invented: 'payments:refund' };
  `;
  const options: ts.CompilerOptions = { noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const host = ts.createCompilerHost(options), getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, version, ...rest) => name === filename
    ? ts.createSourceFile(name, source, version) : getSourceFile(name, version, ...rest);
  const program = ts.createProgram([filename], options, host);
  // This small consumer checks the public option shape; package/source compilation is a separate gate.
  const diagnostics = program.getSemanticDiagnostics().filter(item => item.file?.fileName === filename);
  expect(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n'))).toEqual([]);
}, 60_000); // A full TypeScript program build exceeds the default 5 s when the whole suite shares the CPUs.
