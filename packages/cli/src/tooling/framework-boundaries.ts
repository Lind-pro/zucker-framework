export interface RuntimeImportRule {
  specifier: string;
  matchesFile: (normalizedFile: string) => boolean;
  message: string;
}

const PUBLIC_FRAMEWORK_SUBPATHS = new Set([
  '@zucker-framework/cli/agent-instructions',
  '@zucker-framework/ai/langchain',
  '@zucker-framework/core/privacy',
  '@zucker-framework/core/user-agent',
]);

export function auditFrameworkSourceText(
  file: string,
  source: string,
  rules: readonly RuntimeImportRule[] = [],
): string[] {
  const violations: string[] = [];
  const normalizedFile = file.replaceAll('\\', '/');

  for (const specifier of importedSpecifiers(source)) {
    if (specifier.startsWith('@zucker/')) {
      violations.push(`${file}: replace retired @zucker/ imports with @zucker-framework/`);
    }
    if (specifier.startsWith('@zucker-framework/')) {
      const segments = specifier.split('/');
      if (segments.length !== 2 && !PUBLIC_FRAMEWORK_SUBPATHS.has(specifier)) {
        violations.push(`${file}: import ${specifier} through a documented package public API`);
      }
    }

    if (
      specifier.includes('zucker-framework/packages/') ||
      specifier.includes('zucker-framework/src/')
    ) {
      violations.push(`${file}: do not import Zucker Framework source directly`);
    }

    for (const rule of rules) {
      if (specifier === rule.specifier && rule.matchesFile(normalizedFile)) {
        violations.push(`${file}: ${rule.message}`);
      }
    }
  }

  return violations;
}

export function auditPnpmWorkflowVersions(
  packageManager: string | undefined,
  workflowSources: readonly (readonly [string, string])[],
): string[] {
  const violations: string[] = [];
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageManager ?? '')) {
    violations.push('package.json: packageManager must pin an exact pnpm version');
    return violations;
  }

  const expectedPnpm = packageManager!.slice('pnpm@'.length);
  for (const [file, source] of workflowSources) {
    const setupPattern = /uses:\s*pnpm\/action-setup@[^\n]+/g;
    let match;
    while ((match = setupPattern.exec(source))) {
      const setupBlock = source.slice(match.index, match.index + 260);
      const configuredPnpm = setupBlock.match(/\n\s*version:\s*([^\s#]+)/)?.[1];
      if (configuredPnpm !== expectedPnpm) {
        violations.push(
          `${file}: pnpm ${configuredPnpm ?? 'missing'} does not match packageManager ${expectedPnpm}`,
        );
      }
    }
  }

  return violations;
}

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
  let match;
  while ((match = importPattern.exec(source))) specifiers.push(match[1]);
  return specifiers;
}
