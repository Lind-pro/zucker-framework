import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";

const intlMiddleware = createMiddleware(routing);

/** 需要登录才能访问的路径前缀（不含 locale） */
const PROTECTED_PREFIXES = ["/dashboard"];

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 去掉 locale 前缀（如 /zh/dashboard → /dashboard）
  const pathnameWithoutLocale = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, "");
  const isProtected = PROTECTED_PREFIXES.some((p) => pathnameWithoutLocale.startsWith(p));

  if (isProtected) {
    const token = request.cookies.get("auth-token")?.value;
    if (!token) {
      // 取当前 locale（pathname 的第一段），兜底 zh
      const locale = pathname.split("/")[1] ?? "zh";
      const loginUrl = new URL(`/${locale}/login`, request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
