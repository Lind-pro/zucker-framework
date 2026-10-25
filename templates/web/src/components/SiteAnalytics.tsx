'use client';

import { useEffect, useMemo } from 'react';
import Script from 'next/script';
import { usePathname } from 'next/navigation';
import { resolveSiteAnalytics, type SiteAnalyticsConfig } from '@zucker-framework/fe-analytics/site-analytics';
import { isAccountPath } from '@/lib/account-path';

/** Optional page-load connections. The application owns consent and provider dashboard settings. */
export function SiteAnalytics({ config, nonce }: { config: SiteAnalyticsConfig; nonce?: string }) {
  const pathname = usePathname();
  const plan = useMemo(() => isAccountPath(pathname) ? null : resolveSiteAnalytics(config), [config, pathname]);
  useEffect(() => {
    for (const issue of plan?.issues ?? []) console.warn(`[Site analytics] ${issue.provider}: ${issue.message}`);
  }, [plan]);
  return <>{plan?.scripts.map(script => <Script key={script.id} id={script.id} src={script.src} nonce={nonce} strategy="afterInteractive" onError={() => console.warn(`[Site analytics] ${script.provider}: script loading failed.`)}>{script.content}</Script>)}</>;
}
