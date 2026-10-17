import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run only inside the disposable database owned and cleaned by the NAS runner.
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/zucker_release_\d+_[a-f0-9]{8}$/.test(new URL(connectionString).pathname)) {
  throw new Error('CRUD contract requires the NAS runner disposable release database');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(root, 'templates/server');
const toolRequire = createRequire(join(template, 'package.json'));
const crud = createRequire(import.meta.url)('../packages/crud/dist/index.js');
const directory = mkdtempSync(join(tmpdir(), 'zucker-crud-contract-'));
let client;
try {
  // Neutral fixture: no consumer schema or generated product client enters the library.
  symlinkSync(join(template, 'node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'schema.prisma'), `generator client {
  provider = "prisma-client-js"
  output = "./generated"
  engineType = "client"
}
datasource db {
  provider = "postgresql"
}
model records {
  id String @id
  name String
  deletedAt DateTime?
}
`);
  writeFileSync(join(directory, 'prisma.config.ts'), `import { defineConfig } from 'prisma/config';
export default defineConfig({ schema: './schema.prisma' });\n`);
  execFileSync(process.execPath, [toolRequire.resolve('prisma/build/index.js'), 'generate',
    '--config', join(directory, 'prisma.config.ts')], { cwd: directory, stdio: 'pipe', timeout: 60000 });
  // Prisma copies its runtime next to the generated client. pnpm does not expose
  // that runtime's private dependency through the template's top-level links.
  const clientRequire = createRequire(realpathSync(toolRequire.resolve('@prisma/client/package.json')));
  const privatePeers = join(directory, 'generated/node_modules/@prisma');
  mkdirSync(privatePeers, { recursive: true });
  symlinkSync(dirname(dirname(clientRequire.resolve('@prisma/client-runtime-utils'))),
    join(privatePeers, 'client-runtime-utils'), 'dir');
  const { PrismaClient } = createRequire(join(directory, 'package.json'))('./generated/index.js');
  const { PrismaPg } = toolRequire('@prisma/adapter-pg');
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  await client.$executeRawUnsafe('CREATE TABLE "records" (id TEXT PRIMARY KEY, name TEXT NOT NULL, "deletedAt" TIMESTAMP(3))');
  const adapter = new crud.PrismaAdapter(client);
  const params = new crud.DynamicQueryParamService(new crud.FilterOperatorFactory([
    new crud.EqualsOperator(), new crud.IsNullOperator(),
  ]));
  class Records extends crud.SoftDeleteService {}
  const service = new Records(adapter, new crud.DynamicQueryService(adapter, params), 'records', undefined,
    { defaultOrderField: 'id' });
  await client.records.createMany({ data: [
    { id: 'active', name: 'same' }, { id: 'deleted', name: 'same', deletedAt: new Date(1000) },
  ] });
  assert.equal(await service.count(), 1);
  assert.equal(await service.findByIdOptional('deleted'), null);
  assert.deepEqual((await service.findAll({ filter: { id: 'deleted' } })).data, []);
  await assert.rejects(service.update('deleted', { name: 'forbidden' }), /not found/);
  assert.deepEqual(await service.updateMany({}, { name: 'updated' }), { count: 1 });
  await assert.rejects(service.update('active', { deletedAt: null }), /Use delete\(\) or restore/);
  assert.equal(await service.createQuery().count(), 1);
  await service.transaction(async tx => assert.equal(await tx.model('records').count(), 1));
  assert.equal(await service.deleteBatch(['active', 'deleted']), 1);
  assert.equal(await client.records.count(), 2);
  assert.equal(await service.count(), 0);
  await service.restore('deleted');
  assert.equal(await service.count(), 1);
  await service.forceDelete('active');
  assert.equal(await client.records.count(), 1);
  // An ordinary write which arrives after deletion must fail in PostgreSQL itself.
  await service.create({ id: 'raced', name: 'before' });
  await client.records.update({ where: { id: 'raced' }, data: { deletedAt: new Date() } });
  await assert.rejects(service.update('raced', { name: 'after' }), /not found/);
  assert.equal((await client.records.findUnique({ where: { id: 'raced' } })).name, 'before');
  let counted = false;
  assert.equal(await crud.resolvePageTotal(1, { skip: 0, take: 10 }, async () => { counted = true; return 1; }), 1);
  assert.equal(counted, false);
  process.stdout.write('CRUD PostgreSQL/Prisma contract passed: root fences, atomic writes, retained rows, recovery and totals.\n');
} finally {
  await client?.$disconnect();
  rmSync(directory, { recursive: true, force: true });
}
