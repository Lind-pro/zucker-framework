// @vitest-environment node
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { WebDavStorage } from './webdav-storage';

describe('WebDAV real SDK against synthetic HTTP', () => {
  it('aborts the real SDK request and destroys the source during a pending upload', async () => {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => { disconnected = resolve; });
    const server = createServer((req, res) => {
      if (req.method === 'PROPFIND') {
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/files</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
      } else {
        req.on('data', started);
        req.on('aborted', disconnected);
        req.on('error', () => {});
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const storage = new WebDavStorage({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, username: 'synthetic', password: 'synthetic', basePath: '/files' });
    const source = new PassThrough();
    const controller = new AbortController();
    try {
      const uploading = storage.uploadStream(source, 'cancelled', { signal: controller.signal });
      const rejected = expect(uploading).rejects.toThrow();
      source.write('first bytes');
      await entered;
      controller.abort(new Error('synthetic cancellation'));
      await rejected;
      await closed;
      expect(source.destroyed).toBe(true);
    } finally {
      controller.abort(); source.destroy(); server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends bytes before upload EOF and returns download before response EOF', async () => {
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
    let upload = '';
    let downloadResponse: import('node:http').ServerResponse | undefined;
    const server = createServer((req, res) => {
      if (req.method === 'PROPFIND') {
        const directory = req.url === '/files';
        res.writeHead(207, { 'Content-Type': 'application/xml' });
        res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:displayname>x</d:displayname><d:getcontentlength>6</d:getcontentlength><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype><d:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
      } else if (req.method === 'PUT') {
        req.on('data', (chunk) => { upload += chunk.toString(); uploadStarted(); });
        req.on('end', () => { res.writeHead(201); res.end(); });
      } else if (req.method === 'GET') {
        downloadResponse = res;
        res.writeHead(200, { 'Content-Length': 6 });
        res.write('abc');
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const storage = new WebDavStorage({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, username: 'synthetic', password: 'synthetic', basePath: '/files' });
    try {
      const source = new PassThrough();
      const result = storage.uploadStream(source, 'example');
      source.write('abc');
      await started;
      expect(upload).toBe('abc');
      source.end('def');
      await expect(result).resolves.toMatchObject({ size: 6 });
      const downloaded = await storage.download('example');
      expect(downloaded.size).toBe(6);
      const chunks: Buffer[] = [];
      const reading = (async () => { for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk)); })();
      while (!downloadResponse) await new Promise((resolve) => setImmediate(resolve));
      expect(downloadResponse.writableEnded).toBe(false);
      downloadResponse.end('def');
      await reading;
      expect(Buffer.concat(chunks).toString()).toBe('abcdef');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
