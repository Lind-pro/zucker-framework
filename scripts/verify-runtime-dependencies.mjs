import ts from 'typescript';
import { isBuiltin } from 'node:module';

/** Static ESM imports must be installable without unrelated workspace packages. */
export function assertStaticRuntimeDependencies(manifest, source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const missing = new Set();
  for (const statement of file.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith('.') || isBuiltin(specifier)) continue;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (name === manifest.name || manifest.dependencies?.[name]) continue;
    if (manifest.peerDependencies?.[name] && !manifest.peerDependenciesMeta?.[name]?.optional) continue;
    missing.add(name);
  }
  if (missing.size) throw new Error(`${manifest.name} ${filename} imports missing or optional runtime dependencies: ${[...missing].join(', ')}`);
}
