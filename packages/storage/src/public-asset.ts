import type { BufferedObjectStore } from './verified-object-transfer';

/**
 * Raster image types a public asset may have. Vector (SVG), HTML and every other type are never
 * public assets: anything served from a public origin must not be able to execute in a browser.
 */
export type RasterImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Storage key prefix of every public asset. A public bucket policy or route must cover only this prefix. */
export const PUBLIC_ASSET_PREFIX = 'public-assets/';

const EXTENSIONS: Readonly<Record<RasterImageMime, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};
const BY_EXTENSION: Readonly<Record<string, RasterImageMime>> = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detect a raster image from its magic bytes only; the client-declared MIME type and file name
 * are never consulted. Returns null for anything else, including SVG/XML/HTML text.
 */
export function detectRasterImageMime(body: Buffer): RasterImageMime | null {
  if (!Buffer.isBuffer(body) || body.length < 12) return null;
  if (body.subarray(0, 8).equals(PNG)) return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const gif = body.subarray(0, 6).toString('latin1');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  return null;
}

/** Heuristic for a clearer refusal message; SVG is refused either way because it is not a raster type. */
export function looksLikeSvg(body: Buffer): boolean {
  const head = body.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || head.startsWith('<!doctype svg');
}

/** Content-addressed key: `public-assets/<sha256>.<ext>`. Identical bytes always map to one object. */
export function publicAssetObjectKey(sha256: string, mimeType: RasterImageMime): string {
  if (!/^[0-9a-f]{64}$/.test(sha256) || !EXTENSIONS[mimeType]) throw new RangeError('Invalid public asset identity');
  return `${PUBLIC_ASSET_PREFIX}${sha256}.${EXTENSIONS[mimeType]}`;
}

/** Public file name (`<sha256>.<ext>`) of an asset, used by routes and URLs. */
export function publicAssetFileName(sha256: string, mimeType: RasterImageMime): string {
  return publicAssetObjectKey(sha256, mimeType).slice(PUBLIC_ASSET_PREFIX.length);
}

/**
 * Strict parser for a requested public file name. Only lowercase `<64 hex>.<known ext>` passes, so a
 * route built on it cannot address anything outside the public-asset prefix (no `/`, `..`, `%`).
 */
export function parsePublicAssetFileName(name: unknown): { sha256: string; mimeType: RasterImageMime } | null {
  if (typeof name !== 'string') return null;
  const match = /^([0-9a-f]{64})\.(png|jpg|webp|gif)$/.exec(name);
  return match ? { sha256: match[1], mimeType: BY_EXTENSION[match[2]] } : null;
}

export type PublicAssetState = 'pending' | 'ready';

export interface PublicAssetRecord {
  /** SHA-256 of the stored (re-encoded) bytes; globally unique. */
  sha256: string;
  /** Owner charged for the stored bytes: the first uploader. Later identical uploads are not charged. */
  ownerId: string;
  objectKey: string;
  size: number;
  mimeType: RasterImageMime;
  width: number;
  height: number;
  state: PublicAssetState;
  createdAt: number;
}

export type PublicAssetCandidate = Omit<PublicAssetRecord, 'state'>;

/**
 * Consumer-owned durable metadata port.
 * - `reserve` is atomic on `sha256`: it either inserts a new `pending` row owned by the candidate's
 *   owner (enforcing that owner's quota, throwing `PublicAssetError('QUOTA_EXCEEDED')` when it is
 *   full) or returns the existing row of any owner without charging anyone.
 * - `markReady` sets `state='ready'` idempotently and returns the row.
 * Database errors must reject, never be translated to missing rows.
 */
export interface PublicAssetRepository {
  reserve(candidate: PublicAssetCandidate): Promise<{ asset: PublicAssetRecord; created: boolean }>;
  markReady(sha256: string): Promise<PublicAssetRecord>;
  get(sha256: string): Promise<PublicAssetRecord | null>;
}

/** Decodes untrusted input and re-encodes it (dropping EXIF and other metadata). */
export type PublicImageNormalizer = (body: Buffer, sniffed: RasterImageMime) => Promise<{
  body: Buffer; mimeType: RasterImageMime; width: number; height: number;
}>;

export interface PublicAssetServiceOptions {
  repository: PublicAssetRepository;
  objects: BufferedObjectStore;
  normalize: PublicImageNormalizer;
  /** Largest accepted input. */
  maxInputBytes: number;
  /** Largest stored (re-encoded) object; also the bound of every verified read. */
  maxObjectBytes: number;
  /** URL of a stored object key. Defaults are a host decision (CDN/bucket base or an application route). */
  publicUrl(objectKey: string, fileName: string): string;
  now?: () => number;
}

export interface PublicAssetView {
  sha256: string;
  url: string;
  mimeType: RasterImageMime;
  size: number;
  width: number;
  height: number;
  /** True when identical content was already stored and nothing new was written or charged. */
  deduplicated: boolean;
}

export type PublicAssetErrorCode =
  | 'INVALID_ARGUMENT' | 'UNSUPPORTED_TYPE' | 'SVG_REJECTED' | 'TOO_LARGE' | 'INVALID_IMAGE'
  | 'QUOTA_EXCEEDED' | 'NOT_FOUND' | 'UPLOAD_UNVERIFIED' | 'CONTENT_UNAVAILABLE' | 'METADATA_UNAVAILABLE';

/** Stable, non-sensitive errors; decoder/provider messages are never exposed. */
export class PublicAssetError extends Error {
  constructor(readonly code: PublicAssetErrorCode) {
    super(code);
    this.name = 'PublicAssetError';
  }
}
