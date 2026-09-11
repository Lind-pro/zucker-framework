import { describe, expect, it } from 'vitest';
import { mergeImageManifest, parseKeyValueManifest, verifyImageManifest } from './image-manifest';

const components = {
  api: { repository: 'registry.example.test/product-api' },
  web: { repository: 'registry.example.test/product-web' },
};
const sourceSha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const digest = (component: keyof typeof components, digit = '1') =>
  `${components[component].repository}@sha256:${digit.repeat(64)}`;
const identity = { components, sourceSha, runId: '123' };

describe('immutable image manifests', () => {
  it('merges changed and inherited images while preserving each source', () => {
    const manifest = mergeImageManifest({
      ...identity,
      currentImages: { api: digest('api', '2') },
      previous: { source_sha: oldSha, api: digest('api'), web: digest('web') },
    });
    expect(manifest).toEqual({
      schema_version: '2',
      source_sha: sourceSha,
      candidate_run_id: '123',
      api_source_sha: sourceSha,
      api: digest('api', '2'),
      web_source_sha: oldSha,
      web: digest('web'),
    });
    expect(() => verifyImageManifest(manifest, identity)).not.toThrow();
  });

  it('rejects an incomplete set and a digest outside the configured repository', () => {
    expect(() =>
      mergeImageManifest({ ...identity, currentImages: { api: digest('api') } }),
    ).toThrow('No current or previous digest');
    expect(() =>
      mergeImageManifest({
        ...identity,
        currentImages: { api: digest('web'), web: digest('web') },
      }),
    ).toThrow('expected repository and digest');
    expect(() =>
      mergeImageManifest({
        ...identity,
        currentImages: { api: `${components.api.repository}:latest`, web: digest('web') },
      }),
    ).toThrow('expected repository and digest');
  });

  it('rejects a candidate for a different source or run', () => {
    const manifest = mergeImageManifest({
      ...identity,
      currentImages: { api: digest('api'), web: digest('web') },
    });
    expect(() => verifyImageManifest(manifest, { ...identity, sourceSha: oldSha })).toThrow(
      'does not match release source',
    );
    expect(() => verifyImageManifest(manifest, { ...identity, runId: '124' })).toThrow(
      'does not match selected run',
    );
  });

  it('rejects malformed identity and unsupported previous schema', () => {
    expect(() =>
      mergeImageManifest({ ...identity, sourceSha: 'short', currentImages: {} }),
    ).toThrow('full Git SHA');
    expect(() => mergeImageManifest({ ...identity, runId: 'run', currentImages: {} })).toThrow(
      'numeric',
    );
    expect(() =>
      mergeImageManifest({
        ...identity,
        currentImages: {},
        previous: { source_sha: oldSha, schema_version: '99' },
      }),
    ).toThrow('unsupported schema');
  });

  it('parses literal values and rejects duplicate keys without mutating object prototypes', () => {
    const parsed = parseKeyValueManifest('source_sha=a\nvalue=a=b\n__proto__=literal\n');
    expect(parsed.value).toBe('a=b');
    expect(parsed.__proto__).toBe('literal');
    expect(() => parseKeyValueManifest('x=one\nx=two\n')).toThrow('Duplicate manifest key x');
    expect(() => parseKeyValueManifest('broken')).toThrow('Invalid manifest line');
  });
});
