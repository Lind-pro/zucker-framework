import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import configFactory from './vite.config.ts';

test('standalone admin config resolves only local source and preserves the API prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zucker-admin-config-'));
  const previousDirectory = process.cwd();
  const previousTarget = process.env.API_PROXY_TARGET;
  try {
    process.chdir(directory);
    delete process.env.API_PROXY_TARGET;
    const config = await configFactory({ command: 'serve', mode: 'development' });
    assert.deepEqual(config.resolve.alias, { '@': resolve(import.meta.dirname, 'src') });
    assert.equal(config.server.port, 4201);
    assert.equal(config.server.proxy['/api'].target, 'http://localhost:4200');
    assert.equal(config.server.proxy['/api'].rewrite, undefined);

    await writeFile(join(directory, '.env.local'), 'API_PROXY_TARGET=http://127.0.0.1:4310\n');
    const configured = await configFactory({ command: 'serve', mode: 'development' });
    assert.equal(configured.server.proxy['/api'].target, 'http://127.0.0.1:4310');
  } finally {
    process.chdir(previousDirectory);
    if (previousTarget === undefined) delete process.env.API_PROXY_TARGET;
    else process.env.API_PROXY_TARGET = previousTarget;
    await rm(directory, { recursive: true, force: true });
  }
});
