import ts from 'typescript';
import { isBuiltin } from 'node:module';
import { posix } from 'node:path';

function staticImports(source, filename) {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];
  for (const statement of file.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
      || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    imports.push(statement.moduleSpecifier.text);
  }
  return imports;
}

/** Default entries must work without optional peers; opt-in subpaths may require them. */
export function assertStaticRuntimeDependencies(manifest, source, filename, { allowOptionalPeers = false } = {}) {
  const missing = new Set();
  for (const specifier of staticImports(source, filename)) {
    if (specifier.startsWith('.') || isBuiltin(specifier)) continue;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (name === manifest.name || manifest.dependencies?.[name]) continue;
    if (manifest.peerDependencies?.[name]
      && (allowOptionalPeers || !manifest.peerDependenciesMeta?.[name]?.optional)) continue;
    missing.add(name);
  }
  if (missing.size) throw new Error(`${manifest.name} ${filename} imports missing or optional runtime dependencies: ${[...missing].join(', ')}`);
}

/** Follow local chunks and self exports so an optional subpath cannot weaken the root entry. */
export function assertPackageRuntimeDependencies(manifest, sources) {
  const normalize = (file) => file.replace(/^package\//, '').replace(/^\.\//, '');
  const modules = new Map([...sources].map(([file, source]) => [normalize(file), source]));
  const targets = (value) => {
    if (typeof value === 'string') {
      const target = normalize(value);
      return modules.has(target) ? [target] : [];
    }
    return value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
  };
  const exports = manifest.exports && typeof manifest.exports === 'object'
    && Object.keys(manifest.exports).some((key) => key.startsWith('.'))
    ? manifest.exports : { '.': manifest.exports };
  const rootEntries = targets([manifest.main, manifest.module, manifest.bin, exports['.']]);
  const subpathEntries = Object.entries(exports)
    .filter(([key]) => key.startsWith('./')).flatMap(([, value]) => targets(value));
  const graph = new Map([...modules].map(([file, source]) => [file, staticImports(source, file).flatMap((specifier) => {
    if (specifier.startsWith('.')) return [posix.normalize(posix.join(posix.dirname(file), specifier))];
    if (specifier === manifest.name) return rootEntries;
    if (specifier.startsWith(`${manifest.name}/`)) return targets(exports[`./${specifier.slice(manifest.name.length + 1)}`]);
    return [];
  })]));
  const reachable = (entries) => {
    const seen = new Set();
    const pending = [...entries];
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file) || !modules.has(file)) continue;
      seen.add(file);
      pending.push(...graph.get(file));
    }
    return seen;
  };
  const required = reachable(rootEntries);
  const optIn = reachable(subpathEntries);
  for (const [file, source] of modules) {
    assertStaticRuntimeDependencies(manifest, source, file, {
      // Unexported files remain strict; only an explicit subpath grants optional peers.
      allowOptionalPeers: optIn.has(file) && !required.has(file),
    });
  }
}
