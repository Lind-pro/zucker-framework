import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
const names = Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith('@zucker-framework/'));
const tsc = join(directory, 'node_modules/typescript/bin/tsc');
const run = (args, cwd = directory) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const write = (name, value) => writeFileSync(join(directory, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);

const strictNames = names.filter((name) => !['@zucker-framework/cli', '@zucker-framework/fe-form'].includes(name));
for (const format of ['mts', 'cts']) {
  write(`contract-types.${format}`, strictNames.map((name, index) => format === 'mts'
    ? `import * as p${index} from ${JSON.stringify(name)}; void p${index};`
    : `import p${index} = require(${JSON.stringify(name)}); void p${index};`).join('\n'));
}
write('tsconfig.contracts.json', {
  compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true, skipLibCheck: false, noEmit: true, types: ['node', 'react'] },
  include: ['contract-types.mts', 'contract-types.cts'],
});
run([tsc, '-p', 'tsconfig.contracts.json']);

// Match the shipped frontend template. Ant Design's own declaration graph has
// React 19/strict-library-check issues; still reject an unresolved/any Rule type.
write('frontend-contract.tsx', `import { createElement } from 'react';
import type { FormRule } from 'antd';
import { DynamicForm, FieldType, toAntdRules } from '@zucker-framework/fe-form';
const rules: FormRule[] = toAntdRules([{ type: 'required', message: 'Required' }]);
type Rule = ReturnType<typeof toAntdRules>[number];
const concreteRule: (0 extends (1 & Rule) ? false : true) = true;
const element = createElement(DynamicForm, { definition: { id: 'release', name: 'Release', fields: [{ key: 'title', name: 'Title', type: FieldType.STRING }] }, onFinish: async () => {} });
void [rules, concreteRule, element];\n`);
write('tsconfig.frontend-contract.json', {
  compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx', target: 'ES2022',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true, skipLibCheck: true, noEmit: true, types: ['react', 'react-dom'] },
  include: ['frontend-contract.tsx'],
});
run([tsc, '-p', 'tsconfig.frontend-contract.json']);
const frontendNodeConfig = JSON.parse(readFileSync(join(directory, 'tsconfig.frontend-contract.json'), 'utf8'));
frontendNodeConfig.compilerOptions.module = 'NodeNext';
frontendNodeConfig.compilerOptions.moduleResolution = 'NodeNext';
write('tsconfig.frontend-node-contract.json', frontendNodeConfig);
run([tsc, '-p', 'tsconfig.frontend-node-contract.json']);
write('frontend-render.mjs', `import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { DynamicForm, FieldType } from '@zucker-framework/fe-form';
globalThis.fetch = async () => { throw new Error('External requests are disabled in this render test'); };
const html = renderToString(createElement(DynamicForm, {
  definition: { id: 'release', name: 'Release', fields: [{ key: 'title', name: 'Release smoke', type: FieldType.STRING }] },
  initialValues: { title: 'Synthetic value' }, onFinish: async () => {},
}));
assert(html.includes('Release smoke') && html.includes('Synthetic value'));\n`);
run(['frontend-render.mjs']);

const runtimeNames = names.filter((name) => !name.startsWith('@zucker-framework/fe-') && !['@zucker-framework/cli', '@zucker-framework/ext-kit'].includes(name));
write('runtime-contract.mjs', `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const name of ${JSON.stringify(runtimeNames)}) {
  assert(Object.keys(await import(name)).length, name + ' ESM entry is empty');
  assert(Object.keys(require(name)).length, name + ' CJS entry is empty');
}\n`);
run(['runtime-contract.mjs']);

const cli = join(directory, 'node_modules/@zucker-framework/cli/dist/index.js');
const cliVersion = JSON.parse(readFileSync(join(directory, 'node_modules/@zucker-framework/cli/package.json'), 'utf8')).version;
assert.equal(run([cli, '--version']).trim(), cliVersion);
run([cli, 'init', 'contract-server']);
const project = join(directory, 'contract-server');
const scaffold = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'));
const tsconfig = JSON.parse(readFileSync(join(project, 'tsconfig.json'), 'utf8'));
assert(!JSON.stringify(scaffold).includes('workspace:'));
assert.equal(tsconfig.extends, undefined);
assert.equal(tsconfig.compilerOptions.sourceMap, false);
assert.equal(tsconfig.compilerOptions.module, 'NodeNext');
const secretFile = readFileSync(join(project, '.env'), 'utf8');
assert.match(secretFile, /^JWT_SECRET=[a-f0-9]{64}\n$/);
assert.equal(statSync(join(project, '.env')).mode & 0o777, 0o600);
// Reuse this independently installed consumer's dependencies, never workspace sources.
symlinkSync(join(directory, 'node_modules'), join(project, 'node_modules'), 'dir');
run([tsc, '-p', join(project, 'tsconfig.json')]);

const probe = join(directory, 'server-probe.cjs');
writeFileSync(probe, `const { Server } = require('node:http');
const originalListen = Server.prototype.listen;
Server.prototype.listen = function(port, ...args) {
  this.once('listening', () => process.send?.({ port: this.address().port }));
  return originalListen.call(this, Number(port), '127.0.0.1', args.find(arg => typeof arg === 'function'));
};\n`);
const environment = { ...process.env, PORT: '0', NODE_ENV: 'test' };
delete environment.JWT_SECRET;
const child = fork(join(project, 'dist/main.js'), [], {
  cwd: project, env: environment, execArgv: ['--require', probe], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-8000); });
try {
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error('Generated server startup timed out')), 15000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Generated server exited before startup (${code})`)); });
    child.on('message', (message) => {
      if (typeof message?.port === 'number') { clearTimeout(timer); resolvePort(message.port); }
    });
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/authorize/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'releasefixture', password: 'synthetic-password' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 401);
  await response.text();
} catch (error) {
  const secret = secretFile.match(/^JWT_SECRET=(.+)/m)?.[1];
  throw new Error(`${error.message}\n${secret ? output.replaceAll(secret, '[REDACTED]') : output}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((done) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  }
}
const installedManifest = (name) => JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8'));
const result = { strictTypePackages: strictNames.length, runtimePackages: runtimeNames.length,
  packageVersions: [...new Set(names.map((name) => installedManifest(name).version))],
  frontendAntdVersions: [installedManifest('antd').version], frontendReactVersion: installedManifest('react').version,
  frontend: 'strict Bundler/NodeNext callers, skipLibCheck=true, concrete Rule type and SSR verified', cliVersion,
  standaloneServer: 'compiled and HTTP 401 verified using the generated main entry', node: process.version };
if (process.argv[3]) writeFileSync(resolve(process.argv[3]), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
