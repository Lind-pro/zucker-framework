import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import { cacheControlFor, isProtectedPath, stripLocale } from "./lib/site/cache-policy";

const intlMiddleware = createMiddleware(routing);
const OPEN_GRAPH_IMAGE = /^\/[^/]+\/opengraph-image$/;

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { locale: pathLocale, path: localPath } = stripLocale(pathname);
  // Generated OG images are always addressed with their locale prefix (see lib/site/metadata.ts);
  // skip the as-needed redirect so crawlers get the image directly. Next sets its own caching.
  if (pathLocale && OPEN_GRAPH_IMAGE.test(pathname)) return NextResponse.next();
  const locale = pathLocale ?? routing.defaultLocale;
  // Presence is only a routing hint. The server validates the session and every resource request.
  if (isProtectedPath(localPath) && !request.cookies.get("zucker-session")?.value) {
    const login = new URL(locale === routing.defaultLocale ? "/login" : `/${locale}/login`, request.url);
    // skipProxyUrlNormalize (next.config.ts) leaves Next's internal `_rsc` cache-buster in the URL.
    const search = new URLSearchParams(request.nextUrl.search);
    search.delete("_rsc");
    const query = search.toString();
    login.searchParams.set("redirect", pathname + (query ? `?${query}` : ""));
    const redirect = NextResponse.redirect(login);
    redirect.headers.set("Cache-Control", cacheControlFor({ method: request.method, path: localPath, redirect: true }));
    return redirect;
  }
  const response = intlMiddleware(request);
  const redirect = response.status >= 300 && response.status < 400;
  // Set before rendering so Next keeps it (it only fills Cache-Control when absent). Public pages
  // never set cookies: routing disables the locale cookie and the session is read client-side.
  response.headers.set("Cache-Control", cacheControlFor({ method: request.method, path: localPath, redirect }));
  return response;
}
export const config = { matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"] };
