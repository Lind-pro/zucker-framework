# syntax=docker/dockerfile:1
# Web image (Next.js standalone output) for a `zucker create` workspace. Build from the workspace root:
#   docker build -f apps/web/Dockerfile --build-arg SITE_URL=https://example.com .
# API_URL (the /api rewrite target) and DEFAULT_LOCALE are fixed at build time by Next.js.
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS base
# Package registry for every install in this image (a private mirror, or a local acceptance registry).
ARG NPM_REGISTRY=https://registry.npmjs.org/
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && pnpm config set registry "$NPM_REGISTRY"
WORKDIR /workspace

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
ARG API_URL=http://server:4200/api
ARG SITE_URL=http://localhost:4202
ARG DEFAULT_LOCALE=en
ENV API_URL=${API_URL} SITE_URL=${SITE_URL} DEFAULT_LOCALE=${DEFAULT_LOCALE} NODE_ENV=production
COPY apps/ apps/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter ./apps/web \
 && pnpm --filter ./apps/web build \
 && mkdir -p apps/web/public

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# In a pnpm workspace the standalone tree mirrors the workspace layout (apps/web/server.js).
# The node user owns it because the incremental cache rewrites pages under .next at run time.
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /workspace/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD wget -qO- http://127.0.0.1:3000/robots.txt >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
