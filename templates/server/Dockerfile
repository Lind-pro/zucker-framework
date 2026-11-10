# syntax=docker/dockerfile:1
# Server image for a `zucker create` workspace. Build from the workspace root (it needs the lockfile,
# so run `pnpm install` once and commit pnpm-lock.yaml first):
#   docker build -f apps/server/Dockerfile --target runtime .
# Targets: `migrate` applies Prisma migrations once (prisma migrate deploy); `runtime` serves the API.
# Migrations never run at server start-up.
ARG NODE_IMAGE=node:24-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /workspace

# Dependency layer: invalidated only by the lockfile and workspace settings.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
COPY apps/ apps/
# `prisma generate` loads prisma.config.ts, which requires DATABASE_URL to be set even though generate
# never connects. The placeholder exists only in this RUN's environment: it is not an ENV, so it is not
# in the image metadata or in the `migrate`/`runtime` stages, which get the real URL from compose.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter ./apps/server \
 && DATABASE_URL=postgresql://build:unused@127.0.0.1:5432/build pnpm --filter ./apps/server build \
 && pnpm --filter ./apps/server deploy --prod /deploy/server \
 && cp -R apps/server/dist /deploy/server/ \
 && mkdir -p /deploy/server/content && cp -R apps/server/content/. /deploy/server/content/

# One-shot migration runner (no package manager at run time, so no download as the node user).
# Also runs the explicit administrator setup:
#   docker compose run --rm migrate node_modules/.bin/tsx src/scripts/create-admin.ts
FROM build AS migrate
USER node
WORKDIR /workspace/apps/server
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=4200
WORKDIR /app
COPY --from=build --chown=root:root /deploy/server ./
# Local file storage (development only) writes here; production uses the s3 provider.
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 4200
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD wget -qO- http://127.0.0.1:4200/api/health/ready >/dev/null || exit 1
CMD ["node", "dist/main"]
