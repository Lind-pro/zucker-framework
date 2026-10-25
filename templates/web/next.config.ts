import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

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
