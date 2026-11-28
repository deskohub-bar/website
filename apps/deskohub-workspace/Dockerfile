# syntax=docker/dockerfile:1.7

# The Workspace OCI image: Next.js's standalone server on Node.js 24, built
# from the repository root with Bun and Turbo in the same order as the Vercel
# build (Paraglide and the other generated inputs, compile, source maps,
# generate):
#
#   docker build -f apps/deskohub-workspace/Dockerfile \
#     --secret id=workspace-build-env,src=<env file> \
#     --build-arg WORKSPACE_REVISION_SHA=$(git rev-parse HEAD) .
#
# Build-time configuration, which `next build` validates and prerendering
# reads, arrives as a BuildKit secret holding a shell env file, so no value
# lands in an image layer. Runtime configuration comes from the host.

# Base images pinned by digest for a reproducible build. Bun matches the
# repository's `packageManager` pin.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ARG BUN_IMAGE=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
ENV CI=1 \
    DO_NOT_TRACK=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Turbo runs in its strict env mode: the Workspace build tasks pass the
# secret's variables and the OCI build variables through by name.
ARG WORKSPACE_REVISION_SHA
RUN --mount=type=secret,id=workspace-build-env,required=false \
    set -eu; \
    if [ -f /run/secrets/workspace-build-env ]; then \
      set -a; . /run/secrets/workspace-build-env; set +a; \
    fi; \
    WORKSPACE_BUILD_TARGET=oci WORKSPACE_REVISION_SHA="${WORKSPACE_REVISION_SHA:-}" \
      bun turbo run build --filter=./apps/deskohub-workspace

FROM ${NODE_IMAGE} AS runtime
ARG WORKSPACE_REVISION_SHA
# Next.js leaves SIGTERM to the app (`NEXT_MANUAL_SIG_HANDLE`), whose
# container lifecycle drains in-flight work and flushes telemetry before the
# host's grace period ends. Logs go to stdout as Cloud Logging JSON.
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=8080 \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=true \
    WORKSPACE_RUNTIME_HOST=container \
    WORKSPACE_LOG_FORMAT=cloud-logging-json \
    WORKSPACE_REVISION_SHA=${WORKSPACE_REVISION_SHA}
WORKDIR /app

COPY --from=build --chown=node:node /repo/apps/deskohub-workspace/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/deskohub-workspace/.next/static ./apps/deskohub-workspace/.next/static
COPY --from=build --chown=node:node /repo/apps/deskohub-workspace/public ./apps/deskohub-workspace/public

USER node
EXPOSE 8080
CMD ["node", "apps/deskohub-workspace/server.js"]
