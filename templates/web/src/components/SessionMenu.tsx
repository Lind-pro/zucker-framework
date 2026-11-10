'use client';
import { Coins, LogOut, Shield } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { AccountLink } from '@/components/AccountLink';
import { consoleNav } from '@/lib/site/console-nav';
import { CREDITS_CHANGED_EVENT } from '@/lib/site/credit-events';
import { isLocale, DEFAULT_LOCALE } from '@/lib/site/locales';
import { readCreditBalance, signOut, useAuthHydrated } from '@/lib/site/session';
import { useAuthStore } from '@/lib/stores/auth-store';

interface ShellUser {
  username?: string;
  name?: string;
  email?: string;
}

function useCreditBalance(enabled: boolean) {
  const [balance, setBalance] = useState<number | null | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    readCreditBalance()
      .then((value) => {
        if (active) setBalance(value);
      })
      .catch(() => {
        if (active) setBalance(null);
      });
    return () => {
      active = false;
    };
  }, [enabled, revision]);
  // Charges elsewhere on the page (AI task submitted, chat answer settled) announce a balance change.
  useEffect(() => {
    if (!enabled) return;
    const onChange = () => setRevision((value) => value + 1);
    window.addEventListener(CREDITS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CREDITS_CHANGED_EVENT, onChange);
  }, [enabled]);
  return { balance: enabled ? balance : undefined, refresh: () => setRevision((value) => value + 1) };
}

/**
 * Header session area. Rendered from the persisted fe-auth store after hydration only, so the
 * server HTML is identical for every visitor and stays shared-cacheable.
 */
export function SessionMenu({ adminUrl, compact = false }: { adminUrl: string | null; compact?: boolean }) {
  const t = useTranslations('shell'),
    common = useTranslations('common'),
    rawLocale = useLocale();
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  const hydrated = useAuthHydrated();
  const authenticated = useAuthStore((state) => state.isAuthenticated && Boolean(state.token));
  const user = useAuthStore((state) => state.user) as ShellUser | null;
  const hasPermissions = useAuthStore((state) => state.permissions.length > 0);
  const signedIn = hydrated && authenticated;
  const { balance, refresh } = useCreditBalance(signedIn);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reserve the space until the browser state is read to avoid a signed-out flash.
  if (!hydrated) return <div aria-hidden className={compact ? 'h-9' : 'h-9 w-40'} />;

  if (!signedIn)
    return (
      <div className="flex items-center gap-3" data-testid="session-signed-out">
        <AccountLink href="/login" className="text-sm text-[var(--color-muted)]">
          {common('login')}
        </AccountLink>
        <AccountLink href="/register" className="rounded-lg bg-primary-600 px-4 py-2 text-sm text-white">
          {common('register')}
        </AccountLink>
      </div>
    );

  const displayName = user?.name || user?.username || user?.email || t('console');
  const formatted =
    typeof balance === 'number' ? new Intl.NumberFormat(locale).format(balance) : balance === null ? '—' : '…';

  return (
    <div ref={root} className="relative flex items-center gap-3" data-testid="session-signed-in">
      <AccountLink
        href="/account/credits"
        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-sm tabular-nums"
        aria-label={`${t('credits')}: ${balance === null ? t('creditsUnavailable') : formatted}`}
        data-testid="header-credit-balance"
      >
        <Coins size={16} aria-hidden />
        {formatted}
      </AccountLink>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('accountMenu')}
        onClick={() => {
          if (!open) refresh();
          setOpen(!open);
        }}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-600 text-sm font-semibold uppercase text-white"
      >
        {displayName.trim().charAt(0) || '?'}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t('accountMenu')}
          className="absolute right-0 top-11 z-50 w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-2 shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="truncate font-medium">{displayName}</p>
            {user?.email && <p className="truncate text-xs text-[var(--color-muted)]">{user.email}</p>}
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              {t('credits')}: <span className="tabular-nums">{balance === null ? t('creditsUnavailable') : formatted}</span>
            </p>
          </div>
          <div className="my-1 border-t border-[var(--color-border)]" />
          {consoleNav.map((item) => {
            const Icon = item.icon;
            return (
              <AccountLink
                key={item.id}
                role="menuitem"
                href={item.href}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-card)]"
              >
                {Icon && <Icon size={16} aria-hidden />}
                {item.label[locale]}
              </AccountLink>
            );
          })}
          {hasPermissions && adminUrl && (
            <a
              role="menuitem"
              href={adminUrl}
              rel="noopener"
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-card)]"
              data-testid="header-admin-link"
            >
              <Shield size={16} aria-hidden />
              {t('admin')}
            </a>
          )}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--color-card)] disabled:opacity-60"
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await signOut();
                setOpen(false);
                window.location.assign(locale === DEFAULT_LOCALE ? '/' : `/${locale}`);
              } catch {
                setError(t('signOutFailed'));
              } finally {
                setBusy(false);
              }
            }}
          >
            <LogOut size={16} aria-hidden />
            {busy ? t('signingOut') : t('signOut')}
          </button>
          {error && (
            <p role="alert" className="px-3 py-1 text-xs text-red-500">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
