import { DropdownMenu, Dialog as DialogPrimitive } from 'radix-ui';
import {
  ChevronDown,
  ChevronRight,
  Languages,
  LogOut,
  Menu as MenuIcon,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldAlert,
  Sun,
  UserRound,
  X,
} from 'lucide-react';
import { Fragment, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { LocalStore } from '@zucker-framework/fe-storage';
import { Button } from '../components/button';
import { ErrorState, LoadingState, Notice, toast } from '../components/feedback';
import { useAdminI18n } from '../i18n/context';
import { cn } from '../lib/cn';
import type { AdminPageDefinition } from './config';
import { useAdmin, usePermissionCheck, useResource } from './context';
import { findPage, menuLabel, menuTrail, pageTitle, visibleMenu, type BackendMenuItem } from './menu';

const THEME_KEY = 'zucker-admin-theme';

function useTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(() => LocalStore.get<string>(THEME_KEY) === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return [
    dark,
    () =>
      setDark((value) => {
        LocalStore.set(THEME_KEY, value ? 'light' : 'dark');
        return !value;
      }),
  ];
}

export function LanguageSwitcher() {
  const { t, locale, locales, setLocale } = useAdminI18n();
  if (locales.length < 2) return null;
  return (
    <label className="flex items-center gap-1 text-muted-foreground">
      <Languages className="size-4" aria-hidden="true" />
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value)}
        className="h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {locales.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function NavigationTree({
  items,
  compact,
  onNavigate,
}: {
  items: readonly BackendMenuItem[];
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const { pages } = useAdmin();
  const { t, locale } = useAdminI18n();
  const { pathname } = useLocation();
  // Only the best match is current; its ancestors are expanded/highlighted as its trail.
  const trail = menuTrail(items, pathname);
  const current = trail[trail.length - 1];
  const active = (item: BackendMenuItem): boolean => trail.includes(item);
  const renderItem = (item: BackendMenuItem, depth: number): ReactNode => {
    const label = menuLabel(item, pages, t, locale);
    const isActive = active(item);
    if (item.children?.length && !item.path) {
      return (
        <details key={`${item.id}:${isActive}`} open={isActive || undefined} className="group">
          <summary
            title={compact ? label : undefined}
            className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className={cn('flex-1 truncate', compact && 'sr-only')}>{label}</span>
            {!compact && <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />}
          </summary>
          <ul className={cn('mt-1 space-y-1', !compact && 'ml-3 border-l pl-2')}>
            {item.children.map((child) => (
              <li key={child.id}>{renderItem(child, depth + 1)}</li>
            ))}
          </ul>
        </details>
      );
    }
    const Icon = item.path ? pages.find((page) => page.path === item.path)?.icon : undefined;
    return (
      <>
        <Link
          to={item.path ?? '/'}
          onClick={onNavigate}
          title={compact ? label : undefined}
          aria-current={item === current ? 'page' : undefined}
          className={cn(
            'flex min-h-10 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            item === current ? 'bg-accent font-medium text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {Icon ? (
            <Icon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            compact && <span aria-hidden="true">{label.slice(0, 1)}</span>
          )}
          <span className={cn('truncate', compact && 'sr-only')}>{label}</span>
        </Link>
        {item.children?.length ? (
          <ul className="ml-3 mt-1 space-y-1 border-l pl-2">
            {item.children.map((child) => (
              <li key={child.id}>{renderItem(child, depth + 1)}</li>
            ))}
          </ul>
        ) : null}
      </>
    );
  };
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <li key={item.id}>{renderItem(item, 0)}</li>
      ))}
    </ul>
  );
}

function Breadcrumb({ menu, page }: { menu: readonly BackendMenuItem[]; page?: AdminPageDefinition }) {
  const { pages } = useAdmin();
  const { t, locale } = useAdminI18n();
  const { pathname } = useLocation();
  const crumbs: Array<{ name: string; path?: string }> = menuTrail(menu, pathname).map((item) => ({
    name: menuLabel(item, pages, t, locale),
    path: item.path ?? undefined,
  }));
  if (!crumbs.length && page) crumbs.push({ name: pageTitle(page, locale, t), path: page.path });
  return (
    <nav aria-label={t('shell.breadcrumb')} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.name}:${index}`}>
              {index > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
              <li className="min-w-0 truncate">
                {!last && crumb.path ? (
                  <Link to={crumb.path} className="text-muted-foreground hover:text-foreground">
                    {crumb.name}
                  </Link>
                ) : (
                  <span className={last ? 'font-medium' : 'text-muted-foreground'} aria-current={last ? 'page' : undefined}>
                    {crumb.name}
                  </span>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

function UserMenu() {
  const { session, pages } = useAdmin();
  const { t } = useAdminI18n();
  const navigate = useNavigate();
  const user = session.store((state) => state.user);
  const can = usePermissionCheck();
  const profile = pages.find((page) => page.key === 'profile');
  const signOut = async () => {
    try {
      await session.logout();
      toast.success(t('shell.logoutSucceeded'));
      navigate('/login', { replace: true });
    } catch {
      toast.error(t('shell.logoutFailed'));
    }
  };
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" aria-label={t('common.accountMenu')}>
          <UserRound />
          <span className="hidden max-w-32 truncate sm:inline">{user?.name || user?.username}</span>
          <ChevronDown />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-40 rounded-lg border bg-card p-1 text-sm text-card-foreground shadow-lg"
        >
          {profile && can(profile.permission) && (
            <DropdownMenu.Item
              onSelect={() => navigate(profile.path)}
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 outline-none data-[highlighted]:bg-muted [&_svg]:size-4"
            >
              <UserRound /> {t('shell.profile')}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item
            onSelect={() => void signOut()}
            className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-destructive outline-none data-[highlighted]:bg-muted [&_svg]:size-4"
          >
            <LogOut /> {t('shell.logout')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ForbiddenPage() {
  const { t } = useAdminI18n();
  const { config } = useAdmin();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <ShieldAlert className="size-10 text-warning" aria-hidden="true" />
      <h1 className="text-xl font-semibold">{t('shell.forbiddenTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('shell.forbiddenDescription')}</p>
      <Link to={config.homePath} className="text-sm">
        {t('shell.backHome')}
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  const { t } = useAdminI18n();
  const { config } = useAdmin();
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-xl font-semibold">{t('shell.notFoundTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('shell.notFoundDescription')}</p>
      <Link to={config.homePath} className="text-sm">
        {t('shell.backHome')}
      </Link>
    </div>
  );
}

/** Placeholder for a module whose persistence is not configured; issues no requests. */
export function DisabledFeaturePage() {
  const { t } = useAdminI18n();
  return <Notice tone="info" title={t('shell.disabledTitle')}>{t('shell.disabledDescription')}</Notice>;
}

/** Route-level permission gate: direct URLs without permission show 403 instead of the page. */
export function PageGate({ page }: { page: AdminPageDefinition }) {
  const can = usePermissionCheck();
  if (!can(page.permission)) return <ForbiddenPage />;
  const Component = page.component;
  return (
    <Suspense fallback={<LoadingState />}>
      <Component />
    </Suspense>
  );
}

function FullScreen({ children }: { children: ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-background p-4">{children}</div>;
}

/** Authenticated layout: sidebar from `GET /menu/tree`, header, mobile navigation and content. */
export function AdminLayout() {
  const { session, config, pages, sessionStatus, retryRestore } = useAdmin();
  const { t } = useAdminI18n();
  const location = useLocation();
  const can = usePermissionCheck();
  const isAuthenticated = session.store((state) => state.isAuthenticated);
  const token = session.store((state) => state.token);
  const [compact, setCompact] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, toggleTheme] = useTheme();
  const menu = useResource<BackendMenuItem[]>(
    async (signal) => {
      const items = await session.api.get<unknown>(config.endpoints.menuTree, undefined, { signal });
      if (!Array.isArray(items)) throw new Error('Unexpected menu response');
      return items as BackendMenuItem[];
    },
    [token ? 'signed-in' : 'anonymous'],
    { enabled: Boolean(token) },
  );
  if (sessionStatus === 'restoring')
    return (
      <FullScreen>
        <LoadingState label={t('shell.restoring')} />
      </FullScreen>
    );
  // Only while the summary still waits for its token: "Login again" clears it and routes to /login.
  if (sessionStatus === 'failed' && isAuthenticated && !token)
    return (
      <FullScreen>
        <div className="w-full max-w-md space-y-3">
          <Notice tone="danger" title={t('shell.restoreFailed')}>
            {t('shell.restoreFailedDescription')}
          </Notice>
          <div className="flex gap-2">
            <Button variant="primary" onClick={retryRestore}>
              {t('common.retry')}
            </Button>
            <Button onClick={() => session.store.getState().logout()}>{t('shell.loginAgain')}</Button>
          </div>
        </div>
      </FullScreen>
    );
  if (!isAuthenticated || !token) {
    const redirect = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?${new URLSearchParams({ redirect })}`} replace />;
  }
  const items = visibleMenu(menu.data ?? [], pages, can);
  const page = findPage(pages, location.pathname);
  const nav = (onNavigate?: () => void, isCompact = false) =>
    menu.loading && !menu.data ? (
      <LoadingState />
    ) : (
      <NavigationTree items={items} compact={isCompact} onNavigate={onNavigate} />
    );
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a
        href="#admin-content"
        className="sr-only z-50 rounded bg-primary p-3 text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        {t('common.skipToContent')}
      </a>
      <aside
        className={cn('fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-card lg:flex', compact ? 'w-20' : 'w-60')}
        aria-label={t('shell.navigation')}
      >
        <Link to={config.homePath} className="flex h-14 shrink-0 items-center gap-2 border-b px-5 font-semibold">
          {config.logo}
          <span className={cn('truncate', compact && 'sr-only')}>{config.brandName ?? t('common.appTitle')}</span>
        </Link>
        <nav aria-label={t('shell.navigation')} className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          {nav(undefined, compact)}
        </nav>
        <div className="border-t p-3">
          <Button
            variant="ghost"
            className="w-full"
            aria-label={compact ? t('common.expandMenu') : t('common.collapseMenu')}
            onClick={() => setCompact(!compact)}
          >
            {compact ? <PanelLeftOpen /> : <PanelLeftClose />}
            {!compact && t('common.collapseMenu')}
          </Button>
        </div>
      </aside>
      <div className={cn('min-w-0', compact ? 'lg:pl-20' : 'lg:pl-60')}>
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b bg-card px-4 md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label={t('common.openMenu')}
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              <MenuIcon />
            </Button>
            <Breadcrumb menu={items} page={page} />
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <div className="hidden sm:block">
              <LanguageSwitcher />
            </div>
            <Button variant="ghost" size="icon" aria-label={dark ? t('common.themeLight') : t('common.themeDark')} onClick={toggleTheme}>
              {dark ? <Sun /> : <Moon />}
            </Button>
            <UserMenu />
          </div>
        </header>
        <main id="admin-content" tabIndex={-1} className="min-w-0 p-4 md:p-6">
          {menu.error && (
            <ErrorState className="mb-4" message={`${t('shell.menuLoadFailed')} — ${t('shell.menuLoadFailedDescription')}`} onRetry={menu.reload} />
          )}
          {!menu.error && !menu.loading && items.length === 0 && (
            <Notice tone="info" className="mb-4" title={t('shell.menuEmpty')}>
              {t('shell.menuEmptyDescription')}
            </Notice>
          )}
          <Outlet />
        </main>
      </div>
      <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/40 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(88vw,320px)] flex-col border-r bg-card shadow-xl outline-none lg:hidden">
            <div className="flex h-14 items-center justify-between border-b px-4">
              <DialogPrimitive.Title className="font-semibold">{config.brandName ?? t('common.appTitle')}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">{t('shell.navigation')}</DialogPrimitive.Description>
              <DialogPrimitive.Close
                aria-label={t('common.closeMenu')}
                className="inline-flex size-10 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4"
              >
                <X />
              </DialogPrimitive.Close>
            </div>
            <nav aria-label={t('shell.navigation')} className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
              {nav(() => setMobileOpen(false))}
            </nav>
            <div className="border-t p-3 sm:hidden">
              <LanguageSwitcher />
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
