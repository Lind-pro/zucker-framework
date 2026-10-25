'use client';
import { ThemeProvider, useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { isAccountPath } from '@/lib/account-path';
import type { SiteColorMode } from '@zucker-framework/fe-site/content';
const subscribe = () => () => {};
export function SiteTheme({
  children,
  appearance,
}: {
  children: React.ReactNode;
  appearance: SiteColorMode;
}) {
  const pathname = usePathname();
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={appearance}
      enableSystem
      forcedTheme={isAccountPath(pathname) ? 'dark' : undefined}
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}
export function AppearanceControl({ locale }: { locale: string }) {
  const { theme, setTheme, forcedTheme } = useTheme();
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  if (forcedTheme) return null;
  return (
    <select
      aria-label={locale === 'zh' ? '外观' : 'Appearance'}
      value={mounted ? (theme ?? 'system') : 'system'}
      onChange={(event) => setTheme(event.target.value)}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background)] px-2 py-1.5 text-sm"
    >
      <option value="light">{locale === 'zh' ? '浅色' : 'Light'}</option>
      <option value="dark">{locale === 'zh' ? '深色' : 'Dark'}</option>
      <option value="system">{locale === 'zh' ? '跟随系统' : 'System'}</option>
    </select>
  );
}
