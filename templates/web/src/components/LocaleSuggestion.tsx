'use client';
import { useLocale } from 'next-intl';
import { useState, useSyncExternalStore, useTransition } from 'react';
import { usePathname, useRouter } from '@/i18n/navigation';
import { LOCALE_SUGGESTION, isLocale, preferredLocale, type Locale } from '@/lib/site/locales';

/** Holds no user data: only that the banner was dismissed. Set in the browser, never by a response. */
const DISMISS_COOKIE = 'zucker-locale-hint';
const DISMISS_SECONDS = 24 * 60 * 60;

/**
 * Replaces Accept-Language redirects (which would make cached public HTML vary per visitor):
 * after hydration, offer the visitor's preferred supported language once a day.
 */
const subscribe = () => () => {};
function browserSuggestion(locale: string): Locale | null {
  if (document.cookie.split('; ').some((part) => part.startsWith(`${DISMISS_COOKIE}=`))) return null;
  const preferred = preferredLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
  return preferred && preferred !== locale ? preferred : null;
}

export function LocaleSuggestion() {
  const locale = useLocale(),
    pathname = usePathname(),
    router = useRouter();
  // Server snapshot is null: the server render is identical for every visitor.
  const detected = useSyncExternalStore(subscribe, () => browserSuggestion(locale), () => null);
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();
  const suggested = dismissed ? null : detected;
  if (!suggested || !isLocale(suggested)) return null;
  const copy = LOCALE_SUGGESTION[suggested];
  const dismiss = () => {
    document.cookie = `${DISMISS_COOKIE}=1; Max-Age=${DISMISS_SECONDS}; Path=/; SameSite=Lax`;
    setDismissed(true);
  };
  return (
    <div
      role="region"
      aria-label={copy.message}
      lang={suggested}
      data-testid="locale-suggestion"
      className="border-b border-[var(--color-border)] bg-[var(--color-card)] text-sm"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-2">
        <p>{copy.message}</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={pending}
            className="rounded-lg bg-primary-600 px-3 py-1 text-white disabled:opacity-60"
            onClick={() => {
              dismiss();
              const search = window.location.search;
              startTransition(() => router.replace(`${pathname}${search}`, { locale: suggested }));
            }}
          >
            {copy.switchTo}
          </button>
          <button type="button" className="text-[var(--color-muted)] hover:underline" onClick={dismiss}>
            {copy.dismiss}
          </button>
        </div>
      </div>
    </div>
  );
}
