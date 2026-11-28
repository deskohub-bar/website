# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG BUN_IMAGE=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
# Use the same PostgreSQL + pg_uuidv7 as Workspace's Postgres test lane.
ARG POSTGRES_IMAGE=ghcr.io/fboulnois/pg_uuidv7:1.7.0@sha256:88a8329b8414de7bc8c82b8f26c1749a7055e6b02e08f8656a079b4b7188fb3d

FROM ${NODE_IMAGE} AS node
FROM ${BUN_IMAGE} AS bun

FROM node AS build-tools
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV CI=1 TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

FROM build-tools AS prune
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun x turbo@2.11.4 prune deskohub-workspace-api --docker --out-dir /pruned

FROM build-tools AS dependencies
COPY --from=prune /pruned/json/ ./
COPY --from=prune /pruned/full/patches/ ./patches/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
COPY --from=prune /pruned/full/ ./
COPY --from=prune /repo/tsconfig.json ./tsconfig.json

FROM dependencies AS sandbox-build
RUN bun turbo run build:sandbox --filter=deskohub-workspace-api
RUN mkdir /migrations \
    && for migration in packages/workspace-backend/src/db/migrations/*/migration.sql; do \
         name="${migration%/migration.sql}"; \
         cp "$migration" "/migrations/${name##*/}.sql"; \
       done

FROM ${POSTGRES_IMAGE} AS sandbox
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=sandbox-build /repo/apps/deskohub-workspace-api/dist/sandbox.mjs ./
COPY --from=sandbox-build /migrations/ ./migrations/
COPY apps/deskohub-workspace-api/start-sandbox.sh ./
ARG PROBE_BUILD_VERSION=dev
ENV NODE_ENV=production PORT=8080 WORKSPACE_RUNTIME_HOST=container PROBE_BUILD_VERSION=${PROBE_BUILD_VERSION}
USER postgres
EXPOSE 8080
ENTRYPOINT ["/bin/sh", "/app/start-sandbox.sh"]
CMD []

FROM dependencies AS production-build
RUN bun turbo run build --filter=deskohub-workspace-api

FROM node AS production
WORKDIR /app
COPY --from=production-build /repo/apps/deskohub-workspace-api/dist/workspace-api.mjs ./
ENV NODE_ENV=production PORT=8080 WORKSPACE_RUNTIME_HOST=container
USER node
EXPOSE 8080
CMD ["node", "workspace-api.mjs"]
