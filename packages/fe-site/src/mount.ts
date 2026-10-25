import { resolveSiteConnections, type SiteConnectionIssue, type SiteConnectionsConfig, type SiteConnectionProvider } from './connections';

export interface MountSiteConnectionsOptions {
  /** Explicit document keeps imports and pure helpers safe in server rendering. */
  document: Document;
  nonce?: string;
  onIssue?: (issue: SiteConnectionIssue) => void;
}
export interface MountedSiteConnections {
  mounted: SiteConnectionProvider[];
  issues: SiteConnectionIssue[];
}
const attempts = new WeakMap<Document, Map<SiteConnectionProvider, string>>();

/**
 * Mount once per document, in its head, after the host has checked consent and route eligibility.
 * An executed SDK cannot be unloaded by removing its script. Use a fresh document for account
 * routes and configuration changes; errors never trigger repeated external requests.
 */
export function mountSiteConnections(config: SiteConnectionsConfig, options: MountSiteConnectionsOptions): MountedSiteConnections {
  const plan = resolveSiteConnections(config);
  const result: MountedSiteConnections = { mounted: [], issues: [...plan.issues] };
  const attempted = attempts.get(options.document) ?? new Map<SiteConnectionProvider, string>();
  attempts.set(options.document, attempted);
  const report = (issue: SiteConnectionIssue) => { result.issues.push(issue); options.onIssue?.(issue); };
  for (const issue of plan.issues) options.onIssue?.(issue);
  for (const connection of plan.connections) {
    const fingerprint = JSON.stringify(connection.scripts);
    const previous = attempted.get(connection.provider);
    if (previous !== undefined) {
      if (previous !== fingerprint) report({ provider: connection.provider, message: 'Connection configuration changed after a load attempt; reload the page before changing it.' });
      continue;
    }
    const existing = connection.scripts.map(script => options.document.getElementById(script.id));
    if (existing.some(Boolean)) {
      attempted.set(connection.provider, fingerprint);
      if (!existing.every(element => element?.getAttribute('data-zucker-site-config') === fingerprint)) {
        report({ provider: connection.provider, message: 'Connection already exists with different or incomplete configuration; reload the page before changing it.' });
      }
      continue;
    }
    // Claim before appending: remounts and removed script elements cannot replay a failed load.
    attempted.set(connection.provider, fingerprint);
    for (const specification of connection.scripts) {
      const element = options.document.createElement('script');
      element.id = specification.id;
      element.setAttribute('data-zucker-site-config', fingerprint);
      if (options.nonce) element.nonce = options.nonce;
      if (specification.crossOrigin) element.crossOrigin = specification.crossOrigin;
      for (const [key, value] of Object.entries(specification.attributes ?? {})) element.setAttribute(key, value);
      if (specification.src) {
        element.async = true; element.defer = true; element.src = specification.src;
        element.addEventListener('error', () => report({ provider: connection.provider, message: 'Connection script failed to load.' }), { once: true });
      } else element.textContent = specification.content ?? '';
      options.document.head.appendChild(element);
    }
    result.mounted.push(connection.provider);
  }
  return result;
}
