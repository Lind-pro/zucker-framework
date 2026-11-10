/**
 * Locale-independent public routes listed in sitemap page 0 for every routed locale.
 * Extension point: a feature that adds a static public page exports its own array from its folder
 * and the integration WP spreads it here, e.g. `...aiSitemapRoutes`. CMS entries are listed
 * separately from the content API and must not be added here.
 */
export const staticSitemapRoutes: readonly string[] = ['/', '/pricing', '/blog', '/docs', '/changelog'];
