import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = Object.fromEntries(readdirSync(join(rootDir, 'packages')).map((directory) => {
  const manifest = JSON.parse(readFileSync(join(rootDir, 'packages', directory, 'package.json'), 'utf8'));
  return [manifest.name, manifest];
}));
const server = JSON.parse(readFileSync(join(rootDir, 'templates/server/package.json'), 'utf8'));
const cli = packages['@zucker-framework/cli'];
const framework = ['@zucker-framework/core', '@zucker-framework/common', '@zucker-framework/crud', '@zucker-framework/event', '@zucker-framework/auth'];
const dependencies = Object.fromEntries(framework.map((name) => [name, packages[name].version]));
for (const name of framework) {
  for (const [peer, version] of Object.entries(packages[name].peerDependencies ?? {})) {
    if (packages[name].peerDependenciesMeta?.[peer]?.optional) continue;
    dependencies[peer] ??= version.startsWith('workspace:') ? packages[peer].version : version;
  }
}
for (const name of ['@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/event-emitter', 'reflect-metadata', 'rxjs']) {
  dependencies[name] = server.dependencies[name];
}
dependencies.dotenv = cli.dependencies.dotenv;
const catalog = {
  versions: Object.fromEntries(Object.values(packages).map((manifest) => [manifest.name, manifest.version])),
  server: {
    dependencies,
    devDependencies: {
      '@nestjs/cli': server.devDependencies['@nestjs/cli'],
      '@types/node': cli.devDependencies['@types/node'],
      typescript: server.devDependencies.typescript,
    },
  },
};
const directory = join(rootDir, 'packages/cli/dist');
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'release-catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
