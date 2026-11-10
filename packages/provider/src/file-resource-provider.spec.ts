import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileResourceProvider } from './file-resource-provider';

describe('FileResourceProvider path containment', () => {
  let root: string;
  let base: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-provider-'));
    base = path.join(root, 'res');
    fs.mkdirSync(base);
    fs.mkdirSync(path.join(root, 'res-secret'));
    fs.writeFileSync(path.join(base, 'ok.txt'), 'ok');
    fs.writeFileSync(path.join(root, 'res-secret', 'key.txt'), 'secret');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads files inside the base directory', async () => {
    const provider = new FileResourceProvider('t', base, 'txt');
    expect((await provider.getResource('ok'))?.toString()).toBe('ok');
    expect(await provider.getResource('missing')).toBeUndefined();
  });

  it('rejects a sibling directory sharing the base prefix', async () => {
    const provider = new FileResourceProvider('t', base, 'txt');
    await expect(provider.getResource('../res-secret/key')).rejects.toThrow('Path traversal');
  });

  it('rejects parent and absolute paths', async () => {
    const provider = new FileResourceProvider('t', base);
    await expect(provider.getResource('..')).rejects.toThrow('Path traversal');
    await expect(provider.getResource(path.join(root, 'res-secret', 'key.txt'))).rejects.toThrow('Path traversal');
  });
});
