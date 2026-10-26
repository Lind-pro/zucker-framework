'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { mountSiteConnections, type SiteConnectionsConfig } from '@zucker-framework/fe-site';
import { isAccountPath } from '@/lib/account-path';

/** AccountLink starts a fresh document so executed marketing SDKs cannot follow account forms. */
export function SiteConnections({ config, nonce }: { config: SiteConnectionsConfig; nonce?: string }) {
  const pathname = usePathname();
  useEffect(() => {
    if (isAccountPath(pathname)) return;
    mountSiteConnections(config, { document, nonce, onIssue: issue => {
      console.warn(`[Site connections] ${issue.provider}: ${issue.message}`);
    } });
    // Removing script elements cannot unload SDKs. Configuration/eligibility changes require a fresh document.
  }, [config, nonce, pathname]);
  return null;
}
