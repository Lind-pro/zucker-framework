import { isIP } from 'node:net';
import { assertAllowedOutboundUrl } from '@zucker-framework/core';
export const FILES_TRANSFER_OPTIONS = Symbol('FILES_TRANSFER_OPTIONS');
export const FILES_IMPORT_FETCH = Symbol('FILES_IMPORT_FETCH');
export interface FilesTransferOptions { downloadTtlSeconds: number; importAllowedHosts: readonly string[]; importTimeoutMs: number }
export type FilesImportFetch = (url: string, options: RequestInit) => Promise<Response>;
export function filesTransferOptionsFromEnvironment(env: Readonly<NodeJS.ProcessEnv>): FilesTransferOptions {
  const downloadTtlSeconds = Number(env.FILES_DOWNLOAD_TTL_SECONDS ?? 60), importTimeoutMs = Number(env.FILES_IMPORT_TIMEOUT_MS ?? 15000);
  if (!Number.isSafeInteger(downloadTtlSeconds) || downloadTtlSeconds < 1 || downloadTtlSeconds > 300) throw new Error('FILES_DOWNLOAD_TTL_SECONDS must be between 1 and 300');
  if (!Number.isSafeInteger(importTimeoutMs) || importTimeoutMs < 1 || importTimeoutMs > 30000) throw new Error('FILES_IMPORT_TIMEOUT_MS must be between 1 and 30000');
  const importAllowedHosts = [...new Set((env.FILES_IMPORT_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))];
  for (const host of importAllowedHosts) {
    if (host.includes('*') || host.includes(':') || host.includes('[') || isIP(host) || !host.includes('.')) throw new Error('File import hosts must be explicit HTTPS domain names');
    assertAllowedOutboundUrl(`https://${host}/`, { allowedHosts: [host], allowedProtocols: ['https:'], allowedPorts: [443], allowCredentials: false, allowIpLiterals: false });
  }
  return { downloadTtlSeconds, importTimeoutMs, importAllowedHosts };
}
