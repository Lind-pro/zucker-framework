import type { OutputTicket } from './types';

/**
 * Largest output the page buffers in memory (inline preview, `redeemOutputTicket`). Downloads are not
 * capped here: the server's AI_OUTPUT_MAX_BYTES bounds every stored output.
 */
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
/** Outputs above this size are downloaded by navigation, so the browser streams them to disk. */
export const STREAMED_DOWNLOAD_THRESHOLD_BYTES = 32 * 1024 * 1024;

export type OutputDownloadStrategy = 'blob' | 'navigate';

/**
 * Small outputs are fetched into a Blob (credentials omitted, failures reported in the page); large or
 * unknown sizes navigate to the ticket URL through a temporary `<a download>` so nothing is held in memory.
 */
export function outputDownloadStrategy(bytes: unknown): OutputDownloadStrategy {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 && bytes <= STREAMED_DOWNLOAD_THRESHOLD_BYTES ? 'blob' : 'navigate';
}

/** Same-origin GET URL for a validated ticket (the server strips the query before logging). */
export function streamedDownloadUrl(ticket: Pick<OutputTicket, 'url' | 'expiresAt'>, origin: string, now = Date.now()): string | null {
  const parsed = parseOutputTicket(ticket, origin, now);
  return parsed ? `${parsed.path}?token=${encodeURIComponent(parsed.token)}` : null;
}

/**
 * Accepts only a same-origin private-file ticket (`/api/files/<id>/download?token=…`) that has not
 * expired. Anything else (an absolute provider URL, another path) is refused: the page never
 * renders or fetches a provider URL. Returns the path to POST the token to, and the token.
 */
export function parseOutputTicket(
  ticket: Pick<OutputTicket, 'url' | 'expiresAt'>,
  origin: string,
  now = Date.now(),
): { path: string; token: string } | null {
  if (typeof ticket?.url !== 'string' || typeof ticket.expiresAt !== 'string') return null;
  let url: URL;
  try {
    url = new URL(ticket.url, origin);
  } catch {
    return null;
  }
  const token = url.searchParams.get('token');
  const expires = Date.parse(ticket.expiresAt);
  if (url.origin !== origin || !/^\/api\/files\/[A-Za-z0-9-]{1,80}\/download$/.test(url.pathname)) return null;
  if (!token || !Number.isFinite(expires) || expires <= now) return null;
  return { path: url.pathname, token };
}

/**
 * Redeems a ticket into a Blob. Credentials are omitted: a ticket failure must not refresh or
 * revoke the account session (same rule as the Files page).
 */
export async function redeemOutputTicket(ticket: OutputTicket, signal?: AbortSignal): Promise<Blob> {
  const parsed = parseOutputTicket(ticket, window.location.origin);
  if (!parsed) throw new Error('Invalid download ticket');
  if (Number.isFinite(ticket.bytes) && ticket.bytes > MAX_OUTPUT_BYTES) throw new Error('Output too large');
  const response = await fetch(parsed.path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: parsed.token }),
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!response.ok) throw new Error('Download failed');
  const blob = await response.blob();
  if (blob.size > MAX_OUTPUT_BYTES) throw new Error('Output too large');
  // The ticket's declared type wins over a sniffed one so an <img>/<video> preview gets the right type.
  return ticket.contentType && blob.type !== ticket.contentType ? new Blob([blob], { type: ticket.contentType }) : blob;
}

/** Saves one output with the strategy its declared size selects. */
export async function downloadOutputTicket(ticket: OutputTicket, fileName: string, signal?: AbortSignal): Promise<void> {
  if (outputDownloadStrategy(ticket.bytes) === 'blob') {
    saveBlob(await redeemOutputTicket(ticket, signal), fileName);
    return;
  }
  const url = streamedDownloadUrl(ticket, window.location.origin);
  if (!url) throw new Error('Invalid download ticket');
  clickDownload(url, fileName);
}

function clickDownload(href: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.rel = 'noreferrer';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function saveBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  clickDownload(objectUrl, fileName);
  // Revoke late: an early revoke can cancel a large download that is still being written.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
};
export function outputFileName(kind: string, taskId: string, index: number, contentType: string): string {
  const safeId = taskId.replace(/[^A-Za-z0-9]/g, '').slice(-12) || 'task';
  return `ai-${kind}-${safeId}-${index + 1}.${EXTENSIONS[contentType] ?? 'bin'}`;
}
