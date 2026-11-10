# syntax=docker/dockerfile:1
# Admin SPA image for a `zucker create` workspace. Build from the workspace root:
#   docker build -f apps/admin/Dockerfile .
# Static files are served by unprivileged nginx with an SPA fallback and an /api reverse proxy to
# API_UPSTREAM (default http://server:4200, the compose service).
ARG NODE_IMAGE=node:24-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /workspace

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
# Default UI locale (en or zh), chosen by `zucker create --locale`.
ARG VITE_DEFAULT_LOCALE=en
ENV VITE_DEFAULT_LOCALE=${VITE_DEFAULT_LOCALE}
COPY apps/ apps/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter ./apps/admin \
 && pnpm --filter ./apps/admin build

FROM ${NGINX_IMAGE} AS runtime
ENV API_UPSTREAM=http://server:4200
COPY apps/admin/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /workspace/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
