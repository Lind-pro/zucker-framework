/** Select upload artifacts without reducing verification of the full workspace. */
export function selectReleasePackages(packages, requestedNames) {
  if (requestedNames === undefined) return packages;
  const names = requestedNames.split(',').map((name) => name.trim());
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    throw new Error('Release package selection must contain unique, nonempty package names');
  }
  const available = new Set(packages.map((pkg) => pkg.name));
  for (const name of names) {
    if (!available.has(name)) throw new Error(`Unknown release package: ${name}`);
  }
  return packages.filter((pkg) => names.includes(pkg.name));
}

export function orderReleasePackages(packages) {
  const byName = new Map();
  for (const pkg of packages) {
    if (byName.has(pkg.name)) throw new Error(`Duplicate package in release: ${pkg.name}`);
    byName.set(pkg.name, pkg);
  }
  const done = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(name, path = []) {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`Release dependency cycle: ${[...path, name].join(' -> ')}`);
    visiting.add(name);
    const pkg = byName.get(name);
    const dependencies = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...(pkg.releaseDependencies ?? []),
    ]);
    for (const dependency of [...dependencies].filter((key) => byName.has(key)).sort()) {
      visit(dependency, [...path, name]);
    }
    visiting.delete(name);
    done.add(name);
    ordered.push(pkg);
  }
  for (const name of [...byName.keys()].sort()) visit(name);
  return ordered;
}
