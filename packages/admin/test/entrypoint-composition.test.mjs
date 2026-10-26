import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dependencyCache = resolve(repository, 'templates/server/node_modules');
// Deliberately use native Node package resolution, not Vitest's workspace aliases.
// Each format has its own process; this validates pure ESM and pure CJS consumers.
const fixture = String.raw`
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const format = process.argv[1];
const load = name => format === 'esm' ? import(name) : Promise.resolve(require(name));
const names = ['admin','config','dictionary','cache','credit','logging','form','provider','monitoring','reference','script','rule-engine','storage','rate-limiter','queue'];
for (const name of names) {
  const specifier = '@zucker-framework/' + name;
  const resolved = format === 'esm' ? import.meta.resolve(specifier) : require.resolve(specifier);
  assert(resolved.replaceAll('\\', '/').endsWith(format === 'esm' ? '/dist/index.mjs' : '/dist/index.js'), name + ' resolves to the wrong format: ' + resolved);
  assert(Object.keys(await load(specifier)).length > 0, name + ' has no public exports');
  const manifest = require(specifier + '/package.json');
  assert.equal(manifest.name, specifier);
}
const { Test } = await load('@nestjs/testing');
const { ModulesContainer } = await load('@nestjs/core');
const { EventEmitterModule, EventEmitter2 } = await load('@nestjs/event-emitter');
const auth = await load('@zucker-framework/auth');
const crud = await load('@zucker-framework/crud');
const admin = await load('@zucker-framework/admin');
const config = await load('@zucker-framework/config');
const dictionary = await load('@zucker-framework/dictionary');
const credit = await load('@zucker-framework/credit');
const logging = await load('@zucker-framework/logging');
const notification = await load('@zucker-framework/notification');
const form = await load('@zucker-framework/form');
const event = await load('@zucker-framework/event');
assert(Reflect.getMetadata('imports', admin.ZuckerUsersAdminModule).includes(auth.ZuckerAuthModule), 'Admin and host must use the same AuthModule class');
assert(Reflect.getMetadata('__guards__', admin.UsersController).includes(auth.JwtAuthGuard), 'Admin and host must use the same JwtAuthGuard class');
const module = await Test.createTestingModule({ imports: [
  EventEmitterModule.forRoot(), event.ZuckerEventModule.forRoot(),
  crud.ZuckerCrudModule.forRoot({ adapterClass: crud.InMemoryAdapter }),
  auth.ZuckerAuthModule.forRoot({ jwtSecret: 'synthetic-format-contract-secret', registerControllers: false }),
  config.ZuckerConfigModule.forRoot(), dictionary.ZuckerDictionaryModule.forRoot(),
  credit.ZuckerCreditModule.forRoot(), logging.ZuckerLoggingModule.forRoot(),
  notification.ZuckerNotificationModule.forRoot({ providers: [] }), form.ZuckerFormModule.forRoot(),
  admin.ZuckerAdminModule.forRoot(),
] }).compile();
try {
  assert(module.get(auth.TokenService), 'configured auth token service must be available');
  assert(module.get(admin.UsersController), 'admin users controller must resolve without duplicate providers');
  const emitter = module.get(EventEmitter2);
  for (const Service of [config.ConfigService, config.LayeredConfigService, dictionary.DictionaryService, dictionary.DictionaryItemService, logging.BusinessLogger]) {
    assert.equal(Reflect.get(module.get(Service), 'eventEmitter'), emitter, Service.name + ' must receive the shared EventEmitter2 instance');
  }
  const interceptors = [...module.get(ModulesContainer).values()].flatMap(entry => [...entry.providers.values()])
    .map(provider => provider.instance).filter(instance => instance instanceof logging.AccessLoggerInterceptor);
  assert.equal(interceptors.length, 1, 'access logging has one configured global interceptor');
  assert.equal(Reflect.get(interceptors[0], 'eventEmitter'), emitter, 'the global interceptor must receive the original EventEmitter2 token');
} finally { await module.close(); }
console.log('native ' + format + ' composition passed');
`;

for (const format of ['cjs', 'esm']) {
  test(`native ${format} package graph retains Nest provider identity`, () => {
    const consumer = mkdtempSync(join(tmpdir(), 'zucker-module-format-'));
    const frameworkPackages = ['admin','config','dictionary','cache','credit','logging','form','provider','monitoring','reference','script','rule-engine','storage','rate-limiter','queue','auth','crud','event','notification'];
    const link = (name, target) => {
      const destination = join(consumer, 'node_modules', ...name.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(target, destination, 'dir');
    };
    let output;
    try {
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'format-contract-fixture', private: true, type: 'module' }));
      for (const name of frameworkPackages) link('@zucker-framework/' + name, resolve(repository, 'packages', name));
      for (const name of ['@nestjs/testing', '@nestjs/core', '@nestjs/event-emitter', 'reflect-metadata']) link(name, realpathSync(join(dependencyCache, name)));
      output = execFileSync(process.execPath, ['--input-type=module', '-e', fixture, format], {
        cwd: consumer,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Native ${format} public composition failed:\n${String(error.stderr ?? error.message).slice(-5000)}`);
    } finally { rmSync(consumer, { recursive: true, force: true }); }
    assert.match(output, new RegExp(`native ${format} composition passed`));
  });
}
