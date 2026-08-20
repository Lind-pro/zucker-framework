import { createHash, randomUUID } from 'node:crypto';
import { S3Storage } from '../dist/index.mjs';

const required = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

if (process.env.R2_CANARY !== '1') {
  throw new Error('Set R2_CANARY=1 to run the disposable R2 storage canary');
}
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required canary setting: ${key}`);
}

const storage = new S3Storage({
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  endpoint: process.env.R2_ENDPOINT,
  bucket: process.env.R2_BUCKET,
  region: 'auto',
  forcePathStyle: false,
  objectAclMode: 'none',
  uploadUrlMode: 'public-only',
});
const prefix = `_canary/storage/${randomUUID()}`;
const sourceKey = `${prefix}/source.txt`;
const copyKey = `${prefix}/copy.txt`;
const payload = Buffer.from(`zucker-storage-r2-canary:${randomUUID()}`);
const expectedHash = sha256(payload);
let verified = false;

try {
  const uploaded = await storage.upload(payload, sourceKey, {
    contentType: 'text/plain',
    acl: 'private',
    metadata: { sha256: expectedHash },
  });
  assert(uploaded.key === sourceKey && uploaded.url === '', 'private upload contract');
  assert(await storage.exists(sourceKey), 'uploaded object existence');

  const info = await storage.getFileInfo(sourceKey);
  assert(info?.size === payload.length, 'head object size');

  const downloaded = await read(await storage.download(sourceKey));
  assert(downloaded.length === payload.length, 'download size');
  assert(sha256(downloaded) === expectedHash, 'download hash');

  const listed = await storage.list(prefix);
  assert(
    listed.some((file) => file.key === sourceKey),
    'list prefix',
  );

  await storage.copy(sourceKey, copyKey);
  const copied = await read(await storage.download(copyKey));
  assert(sha256(copied) === expectedHash, 'copy hash');

  const signedUrl = await storage.getDownloadUrl(sourceKey, 300);
  const response = await fetch(signedUrl);
  assert(response.ok, 'signed URL response');
  assert(sha256(Buffer.from(await response.arrayBuffer())) === expectedHash, 'signed URL hash');
  verified = true;
} finally {
  await Promise.allSettled([storage.delete(copyKey), storage.delete(sourceKey)]);
  if (verified) {
    assert(!(await storage.exists(sourceKey)), 'source delete');
    assert(!(await storage.exists(copyKey)), 'copy delete');
  }
  storage.onModuleDestroy();
}

process.stdout.write('R2 canary passed: upload/head/download/list/copy/signed-url/delete\n');

function assert(condition, stage) {
  if (!condition) throw new Error(`R2 canary failed at ${stage}`);
}

async function read(result) {
  const chunks = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
