import type { AITaskKind } from './types';

/** Raster/audio/video types an output may have, by kind. SVG/HTML are never accepted. */
export const DEFAULT_AI_OUTPUT_CONTENT_TYPES: Readonly<Record<AITaskKind, readonly string[]>> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4'],
};

export const AI_OUTPUT_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a',
};

const ascii = (body: Uint8Array, start: number, end: number) => Buffer.from(body.subarray(start, end)).toString('latin1');

/** Detects the media type from magic bytes; returns undefined for anything unrecognised. */
export function sniffMediaType(body: Uint8Array): string | undefined {
  if (body.length < 12) return undefined;
  if (body[0] === 0x89 && ascii(body, 1, 4) === 'PNG') return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (ascii(body, 0, 4) === 'RIFF' && ascii(body, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(body, 0, 6) === 'GIF87a' || ascii(body, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(body, 0, 4) === 'RIFF' && ascii(body, 8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(body, 4, 8) === 'ftyp') {
    const brand = ascii(body, 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    return 'video/mp4';
  }
  if (body[0] === 0x1a && body[1] === 0x45 && body[2] === 0xdf && body[3] === 0xa3) return 'video/webm';
  if (ascii(body, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(body, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(body, 0, 3) === 'ID3' || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return undefined;
}
