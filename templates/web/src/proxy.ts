import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";

const intlMiddleware = createMiddleware(routing);
const PROTECTED_PREFIXES = ["/dashboard", "/account", "/billing", "/content/manage"];

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const first = pathname.split("/")[1];
  const locale = routing.locales.find((value) => value === first) ?? routing.defaultLocale;
  const hasLocale = routing.locales.some((value) => value === first);
  const localPath = hasLocale ? pathname.slice(first.length + 1) || "/" : pathname;
  const protectedPath = PROTECTED_PREFIXES.some((prefix) => localPath === prefix || localPath.startsWith(`${prefix}/`));
  // Presence is only a routing hint. The server validates the session and every resource request.
  if (protectedPath && !request.cookies.get("zucker-session")?.value) {
    const login = new URL(`/${locale}/login`, request.url);
    login.searchParams.set("redirect", pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  return intlMiddleware(request);
}
export const config = { matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"] };
