#!/usr/bin/env node
/**
 * Dependency-free local npm registry for the packed `@zucker-framework/*` tarballs (launch acceptance).
 *
 *   node scripts/acceptance/file-registry.mjs --manifest <out>/manifest.json [--port 0] [--upstream <url>] [--log <file>]
 *
 * Serves only the packages listed in the manifest written by `pack.mjs`:
 *   GET /@zucker-framework%2f<name>  and  /@zucker-framework/<name>     → packument (one version)
 *   GET /@zucker-framework/<name>/-/<name>-<version>.tgz               → that tarball
 * Every other request is answered 404 and logged (offline mode, the default), or, with `--upstream`
 * (proxy mode, needs network), forwarded for package metadata and tarball paths of names outside the
 * `@zucker-framework` scope. A framework name is never proxied: an unknown framework package is a 404,
 * so a consumer can never silently install a published artefact instead of the packed one.
 * Binds 127.0.0.1 (or `--host`). The request log is the evidence of what would have left the machine.
 */
import { createReadStream, readFileSync, appendFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve, basename } from 'node:path';
import { isMainModule } from '../cli-entry.mjs';

const SCOPE = '@zucker-framework';
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Reads `manifest.json` (`{ packages: [{ name, version, file, integrity, shasum }] }`) and validates it. */
export function loadManifest(path) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const directory = dirname(resolve(path));
  const packages = new Map();
  for (const entry of manifest.packages ?? []) {
    if (!PACKAGE_NAME.test(entry.name) || !entry.name.startsWith(`${SCOPE}/`)) throw new Error(`Invalid package name in manifest: ${entry.name}`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry.version)) throw new Error(`Invalid version for ${entry.name}`);
    if (basename(entry.file) !== entry.file) throw new Error(`Tarball path must be a file name: ${entry.file}`);
    const file = resolve(directory, 'tarballs', entry.file);
    statSync(file);
    packages.set(entry.name, { ...entry, path: file, packageJson: entry.packageJson ?? {} });
  }
  return packages;
}

/** Standard tarball path of a scoped package: `/@scope/name/-/name-version.tgz`. */
export function tarballPath(name, version) {
  return `/${name}/-/${name.split('/').pop()}-${version}.tgz`;
}

/** Full packument for one locally packed version. */
export function packument(entry, baseUrl) {
  const time = new Date(entry.packedAt ?? Date.now()).toISOString();
  const { scripts, devDependencies, ...packageJson } = entry.packageJson;
  return {
    _id: entry.name,
    name: entry.name,
    'dist-tags': { latest: entry.version },
    versions: {
      [entry.version]: {
        ...packageJson,
        // Lifecycle hooks that run at install time must reach the consumer; dev-only scripts need not.
        ...(scripts ? { scripts: Object.fromEntries(Object.entries(scripts).filter(([key]) => ['preinstall', 'install', 'postinstall'].includes(key))) } : {}),
        name: entry.name,
        version: entry.version,
        _id: `${entry.name}@${entry.version}`,
        dist: { tarball: `${baseUrl}${tarballPath(entry.name, entry.version)}`, integrity: entry.integrity, shasum: entry.shasum },
      },
    },
    time: { created: time, modified: time, [entry.version]: time },
  };
}

/** Parses a request path into `{ kind: 'packument' | 'tarball', name, file? }`, or null. */
export function parseRequestPath(rawPath) {
  let path;
  try { path = decodeURIComponent(rawPath.split('?')[0]); } catch { return null; }
  if (path.includes('\0') || path.includes('..') || path.includes('\\')) return null;
  const tarball = /^\/((?:@[^/]+\/)?[^/@]+)\/-\/([^/]+\.tgz)$/.exec(path);
  if (tarball) return PACKAGE_NAME.test(tarball[1]) ? { kind: 'tarball', name: tarball[1], file: tarball[2] } : null;
  const meta = /^\/((?:@[^/]+\/)?[^/@]+)\/?$/.exec(path);
  if (meta) return PACKAGE_NAME.test(meta[1]) ? { kind: 'packument', name: meta[1] } : null;
  return null;
}

/**
 * Starts the registry. Returns `{ url, port, close(), requests }`; `requests` collects
 * `{ method, path, name, outcome }` (outcome: served | not-found | proxied | proxy-failed | refused).
 */
export async function startFileRegistry({ manifest, port = 0, host = '127.0.0.1', upstream, log } = {}) {
  const packages = loadManifest(manifest);
  const requests = [];
  const upstreamUrl = upstream ? new URL(upstream) : undefined;
  if (upstreamUrl && upstreamUrl.protocol !== 'https:' && upstreamUrl.hostname !== '127.0.0.1') throw new Error('Upstream must be https');
  let baseUrl = '';
  const record = (entry) => {
    requests.push(entry);
    if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };
  const server = createServer(async (request, response) => {
    const parsed = request.method === 'GET' || request.method === 'HEAD' ? parseRequestPath(request.url ?? '/') : null;
    const name = parsed?.name;
    if (!parsed) {
      record({ method: request.method, path: request.url, outcome: 'refused' });
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    const local = packages.get(parsed.name);
    if (local) {
      if (parsed.kind === 'packument') {
        record({ method: request.method, path: request.url, name, outcome: 'served' });
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument(local, baseUrl)));
        return;
      }
      if (`/${parsed.name}/-/${parsed.file}` === tarballPath(local.name, local.version)) {
        record({ method: request.method, path: request.url, name, outcome: 'served' });
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(local.path).size });
        if (request.method === 'HEAD') response.end(); else createReadStream(local.path).pipe(response);
        return;
      }
    }
    if (!upstreamUrl || parsed.name.startsWith(`${SCOPE}/`)) {
      record({ method: request.method, path: request.url, name, outcome: 'not-found' });
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    try {
      const target = new URL(request.url, upstreamUrl);
      const forwarded = await fetch(target, {
        method: request.method,
        headers: { accept: request.headers.accept ?? 'application/json' },
        redirect: 'follow',
      });
      record({ method: request.method, path: request.url, name, outcome: 'proxied', status: forwarded.status });
      const headers = { 'content-type': forwarded.headers.get('content-type') ?? 'application/octet-stream' };
      response.writeHead(forwarded.status, headers);
      if (request.method === 'HEAD' || !forwarded.body) { response.end(); return; }
      for await (const chunk of forwarded.body) response.write(chunk);
      response.end();
    } catch (error) {
      record({ method: request.method, path: request.url, name, outcome: 'proxy-failed', error: error?.name ?? 'error' });
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end('{"error":"upstream unavailable"}');
    }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, host, done); });
  const address = server.address();
  baseUrl = `http://${host}:${address.port}`;
  return {
    url: `${baseUrl}/`,
    port: address.port,
    requests,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const manifest = option(args, '--manifest');
  if (!manifest) throw new Error('usage: file-registry.mjs --manifest <manifest.json> [--port n] [--host h] [--upstream url] [--log file]');
  const registry = await startFileRegistry({
    manifest, port: Number(option(args, '--port', '0')), host: option(args, '--host', '127.0.0.1'),
    upstream: option(args, '--upstream'), log: option(args, '--log'),
  });
  process.stdout.write(`${JSON.stringify({ url: registry.url, port: registry.port })}\n`);
  const stop = () => registry.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
