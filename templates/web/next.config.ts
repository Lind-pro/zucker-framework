import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

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
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
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
