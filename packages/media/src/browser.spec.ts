// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { build } from 'tsup';
import { describe, expect, it } from 'vitest';
import * as browser from './browser';
import * as server from './index';

describe('media browser entry', () => {
  it('bundles the public browser exports without Node builtins or the RDKit runtime', async () => {
    const outDir = await mkdtemp(resolve(tmpdir(), 'framework-media-browser-'));
    try {
      await expect(build({
        entry: [resolve(import.meta.dirname, 'browser.ts')],
        outDir,
        config: false,
        platform: 'browser',
        format: ['esm'],
        bundle: true,
        // Resolve RDKit if it ever leaks back into this entry: its fs import must fail.
        noExternal: ['@rdkit/rdkit'],
        external: ['mermaid'],
        dts: false,
        silent: true,
      })).resolves.toBeUndefined();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('keeps browser helpers and the Node rendering API compatible', () => {
    expect(browser.resolveImageSource({ imageUrl: ' /image.svg ' })).toBe('/image.svg');
    expect(browser.sanitizeSvgMarkup('<svg><script>alert(1)</script><path/></svg>'))
      .toBe('<svg><path/></svg>');
    expect(browser.renderMermaidSvg).toBe(server.renderMermaidSvg);
    expect(server.renderSmilesSvg).toBeTypeOf('function');
    expect(server.renderVegaLiteSvg).toBeTypeOf('function');
    expect(browser).not.toHaveProperty('renderSmilesSvg');
    expect(browser).not.toHaveProperty('renderVegaLiteSvg');
  });
});
