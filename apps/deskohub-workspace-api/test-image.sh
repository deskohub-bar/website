#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="workspace-api-proof-smoke:$$-${RANDOM}"
container=""

cleanup() {
  if [[ -n "$container" ]]; then
    docker rm -f "$container" >/dev/null
  fi
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker buildx build --load --tag "$image" --target sandbox \
  --build-arg PROBE_BUILD_VERSION=ci-smoke \
  --file "$repo_root/apps/deskohub-workspace-api/Dockerfile" "$repo_root"

create_container() {
  # Exercise startup with a single CPU and 512 MiB of memory.
  container="$(docker create --network none --memory 512m --cpus 1 \
    -e "WORKSPACE_DEPLOYMENT_STAGE=$1" -e "WORKSPACE_SERVICE_ROLE=$2" "$image")"
  docker start "$container" >/dev/null
}

remove_container() {
  docker rm -f "$container" >/dev/null
  container=""
}

for role in api tasks-worker scheduler-worker; do
  create_container sandbox "$role"
  # The Cloud Run startup probe has 30 attempts, spaced 2 seconds apart.
  deadline=$((SECONDS + 60))
  ready=false
  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]]; then
      break
    fi
    if docker exec "$container" node --input-type=module -e '
      try {
        const response = await fetch("http://127.0.0.1:8080/healthz", {
          signal: AbortSignal.timeout(1000),
        });
        const { status, version, role } = await response.json();
        if (
          !process.versions.node.startsWith("24.") ||
          !response.ok || status !== "ok" || version !== "ci-smoke" ||
          role !== process.argv[1]
        ) process.exitCode = 1;
      } catch {
        process.exitCode = 1;
      }
    ' "$role"; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    docker logs "$container" >&2
    echo "Workspace API proof image failed readiness for $role." >&2
    exit 1
  fi
  echo "Workspace API proof image is ready as $role."
  remove_container
done

expect_startup_refusal() {
  create_container "$1" "$2"
  if ! result="$(timeout 15 docker wait "$container")" || [[ "$result" == 0 ]]; then
    docker logs "$container" >&2
    echo "Workspace API proof image failed to reject stage $1 and role $2." >&2
    exit 1
  fi
  remove_container
}

expect_startup_refusal sandbox web
expect_startup_refusal production api
