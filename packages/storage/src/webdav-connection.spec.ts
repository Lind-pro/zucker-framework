// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { WEBDAV_STORAGE_CONNECTION_DESCRIPTOR, webDavOptionsFromConnection } from './connection-descriptor';

const good = { WEBDAV_BASE_URL: 'https://dav.example.invalid/remote.php/dav', WEBDAV_USERNAME: 'user', WEBDAV_PASSWORD: 'secret', WEBDAV_BASE_PATH: '/uploads' };
const message = (environment: Record<string, string | undefined>, options?: { allowAnonymous?: boolean }) => {
  try { webDavOptionsFromConnection(environment, options); } catch (error) { return (error as Error).message; }
  return null;
};

describe('WEBDAV_STORAGE_CONNECTION_DESCRIPTOR', () => {
  it('declares the webdav-storage profile with a secret password and an endpoint field', () => {
    const { profile } = WEBDAV_STORAGE_CONNECTION_DESCRIPTOR;
    expect(profile.id).toBe('webdav-storage');
    expect(profile.fields.map(field => [field.key, field.type])).toEqual([['WEBDAV_BASE_URL', 'url'], ['WEBDAV_USERNAME', 'text'], ['WEBDAV_PASSWORD', 'secret'], ['WEBDAV_BASE_PATH', 'text']]);
    expect(profile.fields.find(field => field.key === 'WEBDAV_BASE_PATH')?.defaultValue).toBe('/');
    expect(Object.isFrozen(WEBDAV_STORAGE_CONNECTION_DESCRIPTOR) && Object.isFrozen(profile) && Object.isFrozen(profile.fields)).toBe(true);
    for (const field of profile.fields) expect(field.labelKey).toBe(`connections.field.${field.key}`);
  });
});

describe('webDavOptionsFromConnection', () => {
  it('parses a complete environment into frozen options', () => {
    const options = webDavOptionsFromConnection(good);
    expect(options).toEqual({ url: good.WEBDAV_BASE_URL, username: 'user', password: 'secret', basePath: '/uploads' });
    expect(Object.isFrozen(options)).toBe(true);
  });
  it('trims values, defaults the base path to / and keeps the password verbatim', () => {
    expect(webDavOptionsFromConnection({ ...good, WEBDAV_BASE_URL: ' https://dav.example.invalid ', WEBDAV_USERNAME: ' user ', WEBDAV_BASE_PATH: '  ', WEBDAV_PASSWORD: ' pw with spaces ' }))
      .toEqual({ url: 'https://dav.example.invalid', username: 'user', password: ' pw with spaces ', basePath: '/' });
    const { WEBDAV_BASE_PATH: _unset, ...withoutPath } = good;
    expect(webDavOptionsFromConnection(withoutPath).basePath).toBe('/');
    expect(webDavOptionsFromConnection({ ...good, WEBDAV_BASE_URL: 'http://localhost:8080/dav' }).url).toBe('http://localhost:8080/dav');
  });
  it.each([
    [{ WEBDAV_BASE_URL: undefined }, 'WEBDAV_BASE_URL is required'],
    [{ WEBDAV_BASE_URL: '' }, 'WEBDAV_BASE_URL is required'],
    [{ WEBDAV_BASE_URL: 'not a url' }, 'WEBDAV_BASE_URL is required'],
    [{ WEBDAV_BASE_URL: 'ftp://dav.example.invalid' }, 'WEBDAV_BASE_URL must be an http(s) URL'],
    [{ WEBDAV_BASE_URL: 'file:///etc/passwd' }, 'WEBDAV_BASE_URL must be an http(s) URL'],
    [{ WEBDAV_BASE_URL: 'javascript:alert(1)' }, 'WEBDAV_BASE_URL must be an http(s) URL'],
    [{ WEBDAV_BASE_URL: 'https://u:p@dav.example.invalid' }, 'without credentials'],
    [{ WEBDAV_BASE_URL: 'https://user@dav.example.invalid' }, 'without credentials'],
    [{ WEBDAV_BASE_URL: 'https://dav.example.invalid/?token=x' }, 'without credentials, query or fragment'],
    [{ WEBDAV_BASE_URL: 'https://dav.example.invalid/#frag' }, 'without credentials, query or fragment'],
    [{ WEBDAV_PASSWORD: undefined }, 'must be set together'],
    [{ WEBDAV_PASSWORD: '' }, 'must be set together'],
    [{ WEBDAV_USERNAME: undefined }, 'must be set together'],
    [{ WEBDAV_USERNAME: '   ' }, 'must be set together'],
    [{ WEBDAV_BASE_PATH: 'relative' }, 'absolute path'],
    [{ WEBDAV_BASE_PATH: '/a/../b' }, 'dot segments'],
    [{ WEBDAV_BASE_PATH: '/a/./b' }, 'dot segments'],
    [{ WEBDAV_BASE_PATH: '/..' }, 'dot segments'],
    [{ WEBDAV_BASE_PATH: '/a\\b' }, 'dot segments'],
    [{ WEBDAV_BASE_PATH: '/a\nb' }, 'dot segments'],
    [{ WEBDAV_BASE_PATH: '/a\u0000b' }, 'dot segments'],
  ])('refuses %j', (override, expected) => {
    expect(message({ ...good, ...override })).toContain(expected);
  });
  it('never echoes a value in the error message', () => {
    const secrets = ['hunter2-password', 'user-name-x', 'top-secret-token'];
    for (const environment of [
      { ...good, WEBDAV_PASSWORD: secrets[0], WEBDAV_USERNAME: undefined },
      { ...good, WEBDAV_BASE_URL: `https://u:${secrets[2]}@dav.example.invalid` },
      { ...good, WEBDAV_BASE_URL: `https://dav.example.invalid/?t=${secrets[2]}` },
      { ...good, WEBDAV_BASE_PATH: `/../${secrets[1]}`, WEBDAV_PASSWORD: secrets[0] },
    ]) for (const secret of secrets) expect(message(environment) ?? '').not.toContain(secret);
  });
  it('anonymous access is an explicit consumer decision', () => {
    const anonymous = { WEBDAV_BASE_URL: good.WEBDAV_BASE_URL };
    expect(message(anonymous)).toContain('are required');
    expect(webDavOptionsFromConnection(anonymous, { allowAnonymous: true })).toEqual({ url: good.WEBDAV_BASE_URL, basePath: '/' });
    // Half-configured credentials are still refused when anonymous access is allowed.
    expect(message({ ...anonymous, WEBDAV_USERNAME: 'user' }, { allowAnonymous: true })).toContain('must be set together');
    expect(message({ ...anonymous, WEBDAV_PASSWORD: 'pw' }, { allowAnonymous: true })).toContain('must be set together');
  });
});
