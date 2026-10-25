const accountPaths = new Set(['login', 'register', 'verify-email', 'forgot-password', 'reset-password', 'dashboard', 'account', 'oauth', 'billing']);

export function isAccountPath(pathname: string): boolean {
  const path = pathname.replace(/^\/(?:en|zh)(?=\/|$)/, '');
  return accountPaths.has(path.split('/')[1] ?? '') || path === '/content/manage' || path.startsWith('/content/manage/');
}
