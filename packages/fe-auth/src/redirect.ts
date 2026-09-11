/** Allow only a local absolute path for navigation after authentication. */
export function isSafeRelativeRedirect(url: string): boolean {
  if (!url.startsWith('/')) return false;
  if (url.includes('://') || url.startsWith('//')) return false;
  if (url.includes('\\') || url.includes('\n') || url.includes('\r')) return false;
  return true;
}
