#!/usr/bin/env bash
set -euo pipefail

registry=europe-west1-docker.pkg.dev
image="$registry/deskohub-workspace-sandbox/workspace-backend-preview/backend"
tag="$image:pr-$PR_NUMBER-$GIT_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"

DOCKER_CONFIG="$(mktemp -d)"
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT

if ! printf '%s' "$GOOGLE_ACCESS_TOKEN" | "$CRANE" auth login "$registry" \
  --username oauth2accesstoken --password-stdin >/dev/null 2>&1; then
  echo 'Artifact Registry authentication failed.' >&2
  exit 1
fi

# Crane transfers the Docker-format archive directly. The deploy runner never
# loads it into a container engine or unpacks its filesystem layers to disk.
if ! image_ref="$("$CRANE" push "$IMAGE_ARCHIVE" "$tag" 2>/dev/null)"; then
  echo 'Publishing the verified preview image failed.' >&2
  exit 1
fi
digest="${image_ref#"$image@sha256:"}"
if [[ "$image_ref" != "$image@sha256:$digest" || ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'Artifact Registry did not return an immutable preview image reference.' >&2
  exit 1
fi
printf 'image_ref=%s@sha256:%s\n' "$image" "$digest" >> "$GITHUB_OUTPUT"
