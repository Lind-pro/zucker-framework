import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

export interface ModuleWiringAuditOptions {
  sourceRoot: string;
  schedulerRoot?: string;
  globalGuards?: {
    owner: string;
    /** Expected useClass registrations, identified by imported/original symbol name. */
    classes: readonly string[];
    /** Expected named useFactory registrations; this does not infer a factory's return class. */
    factories?: readonly string[];
  };
  infrastructureProviders?: Record<string, string>;
}

export interface ModuleWiringFinding {
  code: string;
  message: string;
  location: string;
}

interface ScheduleImports {
  cron: Set<string>;
  modules: Set<string>;
  namespaces: Set<string>;
}

const LIFECYCLE_INTERFACES = new Set([
  'BeforeApplicationShutdown',
  'OnApplicationBootstrap',
  'OnApplicationShutdown',
  'OnModuleDestroy',
  'OnModuleInit',
]);
const LIFECYCLE_METHODS = new Set([
  'beforeApplicationShutdown',
  'onApplicationBootstrap',
  'onApplicationShutdown',
  'onModuleDestroy',
  'onModuleInit',
]);

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

function getImportAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      aliases.set(element.name.text, element.propertyName?.text ?? element.name.text);
    }
  }
  return aliases;
}

function getScheduleModuleImports(sourceFile: ts.SourceFile): ScheduleImports {
  const cron = new Set<string>();
  const modules = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@nestjs/schedule'
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === 'ScheduleModule') {
        modules.add(element.name.text);
      } else if (importedName === 'Cron') {
        cron.add(element.name.text);
      }
    }
  }
  return { cron, modules, namespaces };
}

function isImportedScheduleModule(expression: ts.Expression, imports: ScheduleImports): boolean {
  if (ts.isIdentifier(expression)) {
    return imports.modules.has(expression.text);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.namespaces.has(expression.expression.text) &&
    expression.name.text === 'ScheduleModule'
  );
}

function isImportedCron(expression: ts.Expression, imports: ScheduleImports): boolean {
  if (ts.isIdentifier(expression)) {
    return imports.cron.has(expression.text);
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imports.namespaces.has(expression.expression.text) &&
    expression.name.text === 'Cron'
  );
}

function waitsForCompletion(call: ts.CallExpression): boolean {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  const property = findProperty(options, 'waitForCompletion');
  return property?.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

function enclosingClassName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) return current.name?.text;
    current = current.parent;
  }
  return undefined;
}

function getCronClassNames(sourceFile: ts.SourceFile, scheduleImports: ScheduleImports): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isDecorator(node.parent) &&
      isImportedCron(node.expression, scheduleImports)
    ) {
      const className = enclosingClassName(node);
      if (className) names.push(className);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function expressionName(
  expression: ts.Expression | undefined,
  aliases: Map<string, string>,
): string | undefined {
  if (!expression) return undefined;
  if (ts.isIdentifier(expression)) {
    return aliases.get(expression.text) ?? expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) {
    return expressionName(expression.expression, aliases);
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return expressionName(expression.expression, aliases);
  }
  return undefined;
}

function propertyName(property: { name?: ts.PropertyName }): string | undefined {
  const name = property.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function findProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && propertyName(property) === name,
  );
}

function getModuleMetadata(
  sourceFile: ts.SourceFile,
  aliases: Map<string, string>,
): ts.ObjectLiteralExpression[] {
  const metadata: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      expressionName(node.expression, aliases) === 'Module' &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      metadata.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return metadata;
}

function getProviders(metadata: ts.ObjectLiteralExpression): ts.Expression[] {
  const providers = findProperty(metadata, 'providers');
  if (!providers || !ts.isArrayLiteralExpression(providers.initializer)) return [];
  return providers.initializer.elements.filter((element) => !ts.isSpreadElement(element));
}

function getImplementedLifecycleNames(
  sourceFile: ts.SourceFile,
  aliases: Map<string, string>,
): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name) {
      const implementsLifecycle = (node.heritageClauses ?? []).some(
        (clause) =>
          clause.token === ts.SyntaxKind.ImplementsKeyword &&
          clause.types.some((type) => {
            const localName = type.expression.getText(sourceFile).split('.').at(-1);
            const name = localName ? (aliases.get(localName) ?? localName) : undefined;
            return name && LIFECYCLE_INTERFACES.has(name);
          }),
      );
      const declaresLifecycleHook = node.members.some((member) => {
        const name = propertyName(member);
        return name ? LIFECYCLE_METHODS.has(name) : false;
      });
      if (implementsLifecycle || declaresLifecycleHook) names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function factoryReturnsInjectedInstance(
  factory: ts.Expression,
  injectedParameterNames: Set<string>,
): boolean {
  const returnsInjected = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) {
      return injectedParameterNames.has(expression.text);
    }
    if (ts.isParenthesizedExpression(expression)) {
      return returnsInjected(expression.expression);
    }
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      return returnsInjected(expression.expression);
    }
    if (ts.isConditionalExpression(expression)) {
      return returnsInjected(expression.whenTrue) || returnsInjected(expression.whenFalse);
    }
    return false;
  };

  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) {
    return false;
  }
  if (!ts.isBlock(factory.body)) return returnsInjected(factory.body);

  let unsafe = false;
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      unsafe ||= returnsInjected(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(factory.body);
  return unsafe;
}

function location(
  sourceRoot: string,
  file: string,
  node: ts.Node,
  sourceFile: ts.SourceFile,
): string {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${relative(sourceRoot, file)}:${start.line + 1}`;
}

function finding(code: string, message: string, at: string): ModuleWiringFinding {
  return { code, message, location: at };
}

export function auditModuleWiring({
  sourceRoot,
  schedulerRoot,
  globalGuards,
  infrastructureProviders = {},
}: ModuleWiringAuditOptions) {
  const expectedGlobalGuards = new Set([
    ...(globalGuards?.classes ?? []).map((name) => `useClass:${name}`),
    ...(globalGuards?.factories ?? []).map((name) => `useFactory:${name}`),
  ]);
  if (!statSync(sourceRoot).isDirectory()) {
    throw new Error(`Module source root is not a directory: ${sourceRoot}`);
  }

  const files = listTypeScriptFiles(sourceRoot);
  const parsed = files.map((file) => {
    const source = readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return {
      aliases: getImportAliases(sourceFile),
      file,
      scheduleImports: getScheduleModuleImports(sourceFile),
      sourceFile,
    };
  });
  const lifecycleClasses = new Set(
    parsed.flatMap(({ aliases, sourceFile }) => getImplementedLifecycleNames(sourceFile, aliases)),
  );
  const cronClasses = new Set(
    parsed.flatMap(({ scheduleImports, sourceFile }) =>
      getCronClassNames(sourceFile, scheduleImports),
    ),
  );
  const findings: ModuleWiringFinding[] = [];
  const schedules: string[] = [];
  const cronJobs: string[] = [];
  const guards: Array<{ identity?: string; location: string; relativeFile: string }> = [];
  const coreProviders: Record<string, string[]> = Object.fromEntries(
    Object.keys(infrastructureProviders).map((name) => [name, []]),
  );
  const lifecycleProviders = new Map<string, string[]>();
  const cronProviders = new Map<string, string[]>();

  for (const { aliases, file, scheduleImports, sourceFile } of parsed) {
    const relativeFile = relative(sourceRoot, file);
    const visitSchedule = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isDecorator(node.parent) &&
        isImportedCron(node.expression, scheduleImports)
      ) {
        const at = location(sourceRoot, file, node, sourceFile);
        cronJobs.push(at);
        if (!waitsForCompletion(node)) {
          findings.push(
            finding(
              'cron-overlap-guard',
              '@Cron jobs must set waitForCompletion: true to prevent overlapping runs in one process',
              at,
            ),
          );
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'forRoot' &&
        isImportedScheduleModule(node.expression.expression, scheduleImports)
      ) {
        schedules.push(location(sourceRoot, file, node, sourceFile));
      }
      ts.forEachChild(node, visitSchedule);
    };
    visitSchedule(sourceFile);

    for (const metadata of getModuleMetadata(sourceFile, aliases)) {
      for (const provider of getProviders(metadata)) {
        const directName = expressionName(provider, aliases);
        if (directName && Object.hasOwn(coreProviders, directName)) {
          coreProviders[directName].push(location(sourceRoot, file, provider, sourceFile));
        }
        if (directName && lifecycleClasses.has(directName)) {
          const locations = lifecycleProviders.get(directName) ?? [];
          locations.push(location(sourceRoot, file, provider, sourceFile));
          lifecycleProviders.set(directName, locations);
        }
        if (directName && cronClasses.has(directName)) {
          const locations = cronProviders.get(directName) ?? [];
          locations.push(location(sourceRoot, file, provider, sourceFile));
          cronProviders.set(directName, locations);
        }
        if (!ts.isObjectLiteralExpression(provider)) continue;

        const provide = findProperty(provider, 'provide');
        const useClass = findProperty(provider, 'useClass');
        const factory = findProperty(provider, 'useFactory');
        const useClassName = useClass ? expressionName(useClass.initializer, aliases) : undefined;
        if (useClassName && Object.hasOwn(coreProviders, useClassName)) {
          coreProviders[useClassName].push(location(sourceRoot, file, provider, sourceFile));
        }
        if (useClassName && lifecycleClasses.has(useClassName)) {
          const locations = lifecycleProviders.get(useClassName) ?? [];
          locations.push(location(sourceRoot, file, provider, sourceFile));
          lifecycleProviders.set(useClassName, locations);
        }
        if (useClassName && cronClasses.has(useClassName)) {
          const locations = cronProviders.get(useClassName) ?? [];
          locations.push(location(sourceRoot, file, provider, sourceFile));
          cronProviders.set(useClassName, locations);
        }
        if (provide && expressionName(provide.initializer, aliases) === 'APP_GUARD') {
          const factoryName = factory ? expressionName(factory.initializer, aliases) : undefined;
          guards.push({
            identity:
              useClassName && !factory
                ? `useClass:${useClassName}`
                : factoryName && !useClass
                  ? `useFactory:${factoryName}`
                  : undefined,
            location: location(sourceRoot, file, provider, sourceFile),
            relativeFile,
          });
        }

        const useExisting = findProperty(provider, 'useExisting');
        const existingName = useExisting
          ? expressionName(useExisting.initializer, aliases)
          : undefined;
        if (existingName && lifecycleClasses.has(existingName)) {
          findings.push(
            finding(
              'lifecycle-provider-alias',
              `${existingName} implements a Nest lifecycle hook and must not be exposed through useExisting`,
              location(sourceRoot, file, provider, sourceFile),
            ),
          );
        }

        const inject = findProperty(provider, 'inject');
        if (
          !factory ||
          !inject ||
          !ts.isArrayLiteralExpression(inject.initializer) ||
          (!ts.isArrowFunction(factory.initializer) &&
            !ts.isFunctionExpression(factory.initializer))
        ) {
          continue;
        }
        const factoryFunction = factory.initializer;
        const injectedParameterNames = new Set<string>();
        inject.initializer.elements.forEach((element, index) => {
          const injectedName = expressionName(element, aliases);
          const parameter = factoryFunction.parameters[index];
          if (
            injectedName &&
            lifecycleClasses.has(injectedName) &&
            parameter &&
            ts.isIdentifier(parameter.name)
          ) {
            injectedParameterNames.add(parameter.name.text);
          }
        });
        if (
          injectedParameterNames.size > 0 &&
          factoryReturnsInjectedInstance(factory.initializer, injectedParameterNames)
        ) {
          findings.push(
            finding(
              'lifecycle-provider-factory-alias',
              'factory returns an injected lifecycle provider directly; Nest can invoke its hooks through both provider wrappers',
              location(sourceRoot, file, provider, sourceFile),
            ),
          );
        }
      }
    }
  }

  if (schedulerRoot && (schedules.length !== 1 || !schedules[0]?.startsWith(`${schedulerRoot}:`))) {
    findings.push(
      finding(
        'schedule-root-count',
        `ScheduleModule.forRoot() must appear exactly once in ${schedulerRoot}; found ${schedules.length}`,
        schedules.join(', ') || 'not found',
      ),
    );
  }

  for (const [provider, expectedFile] of Object.entries(infrastructureProviders)) {
    const locations = coreProviders[provider];
    if (locations.length !== 1 || !locations[0].startsWith(`${expectedFile}:`)) {
      findings.push(
        finding(
          'infrastructure-provider-owner',
          `${provider} must be provided exactly once by ${expectedFile}; found ${locations.length}`,
          locations.join(', ') || 'not found',
        ),
      );
    }
  }

  const guardNames = guards
    .map(({ identity }) => identity)
    .filter((name): name is string => Boolean(name));
  const duplicateGuards = guardNames.filter((name, index) => guardNames.indexOf(name) !== index);
  const actualGuardSet = new Set(guardNames);
  if (
    globalGuards &&
    (guards.some(({ relativeFile }) => relativeFile !== globalGuards.owner) ||
      guards.some(({ identity }) => !identity) ||
      duplicateGuards.length > 0 ||
      actualGuardSet.size !== expectedGlobalGuards.size ||
      [...expectedGlobalGuards].some((name) => !actualGuardSet.has(name)))
  ) {
    findings.push(
      finding(
        'global-guard-composition',
        `APP_GUARD must be registered once per expected guard in ${globalGuards.owner}; found ${guardNames.join(', ') || 'none'}`,
        guards.map(({ location: at }) => at).join(', ') || 'not found',
      ),
    );
  }

  for (const [className, locations] of lifecycleProviders) {
    if (locations.length > 1) {
      findings.push(
        finding(
          'duplicate-lifecycle-provider',
          `${className} is provided by multiple modules and would have multiple lifecycle owners`,
          locations.join(', '),
        ),
      );
    }
  }

  for (const className of cronClasses) {
    const locations = cronProviders.get(className) ?? [];
    if (locations.length !== 1) {
      findings.push(
        finding(
          'cron-provider-owner',
          `${className} contains @Cron jobs and must be provided exactly once; found ${locations.length}`,
          locations.join(', ') || 'not found',
        ),
      );
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    stats: {
      files: files.length,
      cronJobs: cronJobs.length,
      cronProviders: cronProviders.size,
      globalGuards: guards.length,
      lifecycleClasses: lifecycleClasses.size,
      scheduleRoots: schedules.length,
    },
  };
}
