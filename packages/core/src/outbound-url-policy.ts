import { isIP } from 'node:net';

export type OutboundUrlRejectionReason =
  | 'invalid-url'
  | 'protocol-not-allowed'
  | 'credentials-not-allowed'
  | 'host-not-allowed'
  | 'ip-literal-not-allowed'
  | 'local-host-not-allowed'
  | 'port-not-allowed';

export class OutboundUrlRejectedError extends Error {
  constructor(
    readonly reason: OutboundUrlRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'OutboundUrlRejectedError';
  }
}

export interface OutboundUrlPolicy {
  /** Exact host names controlled by the application operator. */
  allowedHosts: readonly string[];
  allowedProtocols?: readonly ('https:' | 'http:')[];
  allowedPorts?: readonly number[];
  allowCredentials?: boolean;
  allowIpLiterals?: boolean;
}

/**
 * Validate an outbound URL against an operator-controlled exact host allowlist.
 *
 * This deliberately does not accept arbitrary public DNS names. An explicit
 * allowlist avoids DNS-rebinding gaps that arise when applications validate a
 * hostname in one lookup and let their HTTP client resolve it again later.
 */
export function assertAllowedOutboundUrl(input: string | URL, policy: OutboundUrlPolicy): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new OutboundUrlRejectedError('invalid-url', 'Outbound URL is invalid');
  }

  const protocols = policy.allowedProtocols ?? ['https:'];
  if (!protocols.includes(url.protocol as 'https:' | 'http:')) {
    throw new OutboundUrlRejectedError(
      'protocol-not-allowed',
      `Outbound URL protocol is not allowed: ${url.protocol}`,
    );
  }
  if (!policy.allowCredentials && (url.username || url.password)) {
    throw new OutboundUrlRejectedError(
      'credentials-not-allowed',
      'Outbound URL credentials are not allowed',
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new OutboundUrlRejectedError(
      'local-host-not-allowed',
      'Localhost outbound URLs are not allowed',
    );
  }
  if (!policy.allowIpLiterals && isIP(hostname) !== 0) {
    throw new OutboundUrlRejectedError(
      'ip-literal-not-allowed',
      'IP-literal outbound URLs are not allowed',
    );
  }

  const allowedHosts = new Set(policy.allowedHosts.map((host) => normalizeAllowedHost(host)));
  if (!allowedHosts.has(hostname)) {
    throw new OutboundUrlRejectedError('host-not-allowed', 'Outbound URL host is not allowlisted');
  }

  const effectivePort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const allowedPorts =
    policy.allowedPorts ?? protocols.map((protocol) => (protocol === 'https:' ? 443 : 80));
  if (!allowedPorts.includes(effectivePort)) {
    throw new OutboundUrlRejectedError(
      'port-not-allowed',
      `Outbound URL port is not allowed: ${effectivePort}`,
    );
  }

  return url;
}

function normalizeAllowedHost(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, '');
  if (!trimmed || trimmed.includes('/') || trimmed.includes('@')) {
    throw new OutboundUrlRejectedError(
      'host-not-allowed',
      'Outbound URL allowlist contains an invalid host',
    );
  }
  return trimmed;
}
