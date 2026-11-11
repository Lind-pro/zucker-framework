import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * DEFAULT_LOCALE is chosen when the project is created and inlined at build time so the proxy,
 * server and browser bundles route identically. Keep this list in sync with src/lib/site/locales.ts
 * (that module cannot be imported here without TS extension imports).
 */
function defaultLocale(value = process.env.DEFAULT_LOCALE?.trim() ?? "") {
  if (value && !["en", "zh"].includes(value)) throw new Error(`DEFAULT_LOCALE must be "en" or "zh" (received "${value}")`);
  return value || "en";
}

/**
 * Baseline response hardening for every route. The CSP deliberately leaves script/style/connect
 * sources open because site analytics, ads and connection scripts are configured at runtime; it
 * blocks framing (clickjacking), plugins and <base> hijacking. To adopt a strict nonce-based
 * script-src, set `x-nonce` on the request in src/proxy.ts and emit the matching CSP there: the
 * root layout already forwards that nonce to SiteAnalytics and SiteConnections.
 */
function securityHeaders(production = process.env.NODE_ENV === "production") {
  return [
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
    // HSTS only for production builds; browsers ignore it over plain HTTP anyway.
    ...(production ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
  ];
}

const nextConfig: NextConfig = {
  // Optional separate build directory (several e2e builds with different API_URL side by side).
  ...(process.env.NEXT_DIST_DIR?.trim() ? { distDir: process.env.NEXT_DIST_DIR.trim() } : {}),
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  env: { DEFAULT_LOCALE: defaultLocale() },
  transpilePackages: [
    "@zucker-framework/fe-auth",
    "@zucker-framework/fe-http-client",
  ],
  typescript: {
    ignoreBuildErrors: false,
  },
  // Proxy URLs can contain OAuth codes or optional download tickets. Server-side audit logs
  // already retain redacted request metadata; do not emit raw incoming URLs from the Web host.
  logging: { incomingRequests: false },
  // Give the proxy the URL Next routed (`initURL`, built from the bound -H/HOSTNAME and port) instead of
  // a rebuilt `localhost:<port>` URL. Otherwise, when the server binds a specific address such as
  // `next start -H 127.0.0.1`, next-intl's as-needed rewrite (/pricing → /en/pricing) gets a foreign
  // origin, is proxied as an external rewrite, and the prefixed request redirects back to /pricing
  // forever. The Host header plays no part here; canonical URLs still come only from SITE_URL.
  skipProxyUrlNormalize: true,
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
  async rewrites() {
    const apiUrl = (process.env.API_URL || "http://localhost:4200/api").replace(/\/+$/, "");
    return [
      {
        source: "/api/:path*",
        destination: `${apiUrl}/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
