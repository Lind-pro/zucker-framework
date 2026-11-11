import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { LocalStore } from '@zucker-framework/fe-storage';
import { AdminToaster } from '../components/feedback';
import { AdminI18nProvider, createServerLabel, createTranslate, type AdminI18nValue } from '../i18n/context';
import { zhCN, type AdminMessages } from '../i18n/zh-CN';
import { createDefaultPages } from '../pages/registry';
import { resolveConfig, type AdminAppConfig, type AdminPageDefinition, type ResolvedAdminConfig } from './config';
import { AdminContext, useSessionRestore, type AdminContextValue } from './context';
import { AdminLayout, NotFoundPage, PageGate } from './layout';
import { LoginPage } from './login';
import { createAdminSession, type AdminSession } from './session';

const LOCALE_KEY = 'zucker-admin-locale';
/**
 * Built-in copy. zh-CN is the base/fallback and ships with the shell; other built-in locales are
 * separate chunks loaded when first selected.
 */
const builtInLoaders: Record<string, () => Promise<AdminMessages>> = {
  'en-US': () => import('../i18n/en-US').then((module) => module.enUS),
};
const builtInMessages = new Map<string, AdminMessages>([['zh-CN', zhCN]]);

/** Load (once) the built-in copy of a locale; unknown tags resolve to zh-CN. */
export async function loadAdminMessages(locale: string): Promise<AdminMessages> {
  const cached = builtInMessages.get(locale);
  if (cached) return cached;
  const loader = builtInLoaders[locale];
  if (!loader) return zhCN;
  const messages = await loader();
  builtInMessages.set(locale, messages);
  return messages;
}
const needsLoad = (locale: string) => !builtInMessages.has(locale) && Object.hasOwn(builtInLoaders, locale);

type DataRouter = ReturnType<typeof createBrowserRouter>;

export interface AdminApp {
  /** Root component: providers, router and toasts. */
  App: ComponentType;
  routes: RouteObject[];
  pages: readonly AdminPageDefinition[];
  session: AdminSession;
  config: ResolvedAdminConfig;
}

export interface CreateAdminAppOptions {
  /** Router factory (default `createBrowserRouter(routes, { basename })`); tests pass a memory router. */
  createRouter?: (routes: RouteObject[]) => DataRouter;
}

/** Built-in pages after product overrides and additions; later definitions replace earlier paths. */
export function resolvePages(config: AdminAppConfig, resolved: ResolvedAdminConfig): AdminPageDefinition[] {
  const builtIn = createDefaultPages(resolved.permissions).flatMap((page) => {
    const override = config.pages?.[page.key as keyof NonNullable<AdminAppConfig['pages']>];
    if (override === false) return [];
    return [{ ...page, ...override, key: page.key } as AdminPageDefinition];
  });
  const extra = config.extraPages ?? [];
  const byPath = new Map<string, AdminPageDefinition>();
  for (const page of [...builtIn, ...extra]) {
    if (!page.path.startsWith('/')) throw new Error(`Admin page path must be absolute: ${page.path}`);
    byPath.set(page.path, page);
  }
  return [...byPath.values()];
}

function messagesFor(locale: string, config: AdminAppConfig): AdminMessages {
  return { ...(builtInMessages.get(locale) ?? zhCN), ...config.locales?.[locale]?.messages, ...config.messages } as AdminMessages;
}

/** `null` until the initial locale's built-in copy has loaded (avoids flashing the fallback copy). */
function useLocaleState(config: AdminAppConfig): AdminI18nValue | null {
  const available = Object.keys(config.locales ?? {});
  const [requested, setLocaleState] = useState(() => {
    const stored = LocalStore.get<string>(LOCALE_KEY);
    return stored && available.includes(stored) ? stored : (config.locale ?? 'zh-CN');
  });
  // The rendered locale switches only once its copy is available; until then the previous one stays.
  const [locale, setLocale] = useState<string | null>(() => (needsLoad(requested) ? null : requested));
  useEffect(() => {
    if (!needsLoad(requested)) {
      setLocale(requested);
      return;
    }
    let active = true;
    loadAdminMessages(requested)
      .catch(() => undefined)
      .finally(() => {
        // A failed chunk load falls back to the base copy instead of leaving the app blank.
        if (active) {
          if (needsLoad(requested)) builtInMessages.set(requested, zhCN);
          setLocale(requested);
        }
      });
    return () => {
      active = false;
    };
  }, [requested]);
  useEffect(() => {
    if (locale) document.documentElement.lang = locale;
  }, [locale]);
  return useMemo(() => {
    if (!locale) return null;
    const messages = messagesFor(locale, config);
    return {
      locale,
      messages,
      t: createTranslate(messages),
      serverLabel: createServerLabel(config.serverLabels, locale),
      locales: available.map((value) => ({ value, label: config.locales![value]!.label })),
      setLocale: (next: string) => {
        if (!available.includes(next)) return;
        LocalStore.set(LOCALE_KEY, next);
        setLocaleState(next);
      },
    };
    // `available` is derived from config, which is fixed for the app's lifetime.
  }, [locale, config]);
}

const RELOAD_ON_FOCUS_INTERVAL_MS = 30_000;

/** `session.reloadOnFocus`: refresh user and permissions on focus/online, throttled. */
function useReloadOnFocus(session: AdminSession, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    const reload = () => {
      if (Date.now() - last < RELOAD_ON_FOCUS_INTERVAL_MS || !session.store.getState().token) return;
      last = Date.now();
      session.reloadMe().catch(() => undefined);
    };
    window.addEventListener('focus', reload);
    window.addEventListener('online', reload);
    return () => {
      window.removeEventListener('focus', reload);
      window.removeEventListener('online', reload);
    };
  }, [session, enabled]);
}

/**
 * Create the back-office application: login, session restore, menu from `GET /menu/tree`,
 * permission-gated routes for the built-in pages plus product pages, and toasts.
 */
export function createAdminApp(config: AdminAppConfig = {}, options: CreateAdminAppOptions = {}): AdminApp {
  const resolved = resolveConfig(config);
  const session = createAdminSession(config, resolved);
  const pages = resolvePages(config, resolved);
  const routes: RouteObject[] = [
    { path: '/login', element: <LoginPage /> },
    {
      path: '/',
      element: <AdminLayout />,
      children: [
        { index: true, element: <Navigate to={resolved.homePath} replace /> },
        ...pages.map((page) => ({ path: page.path.slice(1), element: <PageGate page={page} /> })),
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ];
  function App() {
    const i18n = useLocaleState(config);
    return i18n ? <AppWithLocale i18n={i18n} /> : null;
  }
  function AppWithLocale({ i18n }: { i18n: AdminI18nValue }) {
    const { status, retry } = useSessionRestore(session);
    const [router] = useState<DataRouter>(
      () => options.createRouter?.(routes) ?? createBrowserRouter(routes, { basename: resolved.basename }),
    );
    useEffect(() => {
      document.title = resolved.brandName ?? i18n.t('common.appTitle');
    }, [i18n]);
    useReloadOnFocus(session, config.session?.reloadOnFocus === true);
    const value = useMemo<AdminContextValue>(
      () => ({ config: resolved, session, pages, sessionStatus: status, retryRestore: retry }),
      // retry is stable in behavior; status drives updates
      [status],
    );
    return (
      <AdminI18nProvider value={i18n}>
        <AdminContext.Provider value={value}>
          <RouterProvider router={router} />
          <AdminToaster />
        </AdminContext.Provider>
      </AdminI18nProvider>
    );
  }
  return { App, routes, pages, session, config: resolved };
}
