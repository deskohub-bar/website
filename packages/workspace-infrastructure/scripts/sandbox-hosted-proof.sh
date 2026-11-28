#!/usr/bin/env bash
# Hosted Slice 1-B proof runner for the disposable Workspace sandbox
# (#1452, #1453). `.github/workflows/workspace-gcp-sandbox-smoke.yml` calls
# one phase per step; only that workflow, dispatched on main in the
# workspace-gcp-sandbox environment, can reach the sandbox project.
#
#   sandbox-hosted-proof.sh [--dry-run] <phase|hosted-proof|cleanup-only>...
#
# --dry-run prints the command sequence and never runs gcloud, docker,
# curl or the release command. Proof state between steps lives in
# SANDBOX_PROOF_DIR (uploaded as a workflow artifact); it never holds a
# token. Every Alchemy write goes through the release command or the
# writer-locked helper, so this runner is never a second stack writer.
# The three Cloud Run services are IAM-private: the runner reaches them
# only with a workspace-api ID token the workflow mints, Cloud Tasks and
# Cloud Scheduler OIDC, or Cloud Run readback. The run's synthetic marker
# and that token live in SANDBOX_PROOF_PRIVATE_DIR, outside the uploaded
# proof directory, and are never printed.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${package_dir}/../.." && pwd)"

hosted_proof_phases=(
  baseline-inventory
  foundation
  images
  deliver-v1
  private-access
  rpc-probe
  worker-probe
  deliver-v2
  drift
  interrupt-recover
  state-snapshot-restore
  restore-v1
  telemetry-privacy
  stack-destroy
  post-destroy-inventory
)
cleanup_phases=(stack-destroy post-destroy-inventory)

usage() {
  cat >&2 <<EOF
usage: $0 [--dry-run] <phase>...
  aliases: hosted-proof (${hosted_proof_phases[*]})
           cleanup-only (${cleanup_phases[*]})
  phases:  guard preflight readonly-inventory and every phase above
EOF
  exit 64
}

dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
[[ $# -gt 0 ]] || usage

if $dry_run; then
  # Synthetic identifiers only; nothing below reaches Google Cloud.
  : "${GCP_SANDBOX_PROJECT_ID:=deskohub-workspace-sandbox}"
  : "${GCP_SANDBOX_STATE_BUCKET:=deskohub-workspace-sandbox-workspace-state}"
  : "${GCP_SANDBOX_DEPLOY_SA:=workspace-deployer@${GCP_SANDBOX_PROJECT_ID}.iam.gserviceaccount.com}"
  : "${SANDBOX_EXPECTED_PROJECT_ID:=deskohub-workspace-sandbox}"
  : "${SANDBOX_EXPECTED_PROJECT_NUMBER:=759037106024}"
  : "${SANDBOX_EXPECTED_STATE_BUCKET:=deskohub-workspace-sandbox-workspace-state}"
  : "${SANDBOX_REGION:=europe-west1}"
  : "${SANDBOX_PROOF_MODE:=hosted-proof}"
  : "${GITHUB_REF:=refs/heads/main}"
  : "${GITHUB_SHA:=0000000000000000000000000000000000000000}"
  : "${GITHUB_RUN_ID:=0}"
  : "${GITHUB_RUN_ATTEMPT:=1}"
  : "${SANDBOX_PROOF_DIR:=$(mktemp -d)}"
  : "${SANDBOX_PROOF_PRIVATE_DIR:=$(mktemp -d)}"
fi

: "${SANDBOX_PROOF_DIR:=${RUNNER_TEMP:-/tmp}/sandbox-proof}"
proof_dir="$SANDBOX_PROOF_DIR"
mkdir -p "$proof_dir"
# The run's marker and the workspace-api ID token: never in the proof
# directory, which the workflow uploads as an artifact.
: "${SANDBOX_PROOF_PRIVATE_DIR:=${RUNNER_TEMP:-/tmp}/sandbox-proof-private}"
private_dir="$SANDBOX_PROOF_PRIVATE_DIR"
marker_file="${private_dir}/marker"
id_token_file="${private_dir}/api-id-token"
task_body_file="${private_dir}/task-body.json"
# The token file and task body go when the runner exits; the marker stays
# for later steps.
trap 'rm -f "$id_token_file" "$task_body_file"' EXIT

project_id="${GCP_SANDBOX_PROJECT_ID:-}"
# Alchemy pairs GOOGLE_ACCESS_TOKEN with this project.
export GOOGLE_PROJECT_ID="$project_id"
state_bucket="${GCP_SANDBOX_STATE_BUCKET:-}"
region="${SANDBOX_REGION:-}"
stage=sandbox
stack_prefix="DeskohubWorkspace/${stage}/"
lease_object="${stack_prefix}__lease__.json"
record_object="workspace-release-record.${stage}.json"
api_service=workspace-api
tasks_worker_service=workspace-tasks-worker
scheduler_worker_service=workspace-scheduler-worker
release_services=("$api_service" "$tasks_worker_service" "$scheduler_worker_service")
artifact_repository=workspace
probe_image=workspace
mobile_updates_bucket="${project_id}-mobile-updates"
# The stack grants these roles/run.invoker on workspace-api.
frontend_invoker="workspace-frontend-preview@${project_id}.iam.gserviceaccount.com"
tasks_invoker="workspace-tasks-invoker@${project_id}.iam.gserviceaccount.com"
scheduler_invoker="workspace-scheduler-invoker@${project_id}.iam.gserviceaccount.com"
# The worker probe's queue contract and the sandbox-only paused job, each
# suffixed with the run's queue suffix.
proof_queue=workspace-paid-fulfillment
proof_queue_path=/api/queues/workspace/paid-fulfillment
proof_schedule_job=workspace-proof-tick
proof_schedule_path=/api/cron/workspace/proof-tick
rpc_content_type=application/vnd.effect.rpc+schema-binary
# Set by load_marker; trace() redacts it.
marker=""
# Resource classes the IAM-private topology never declares: none may exist
# before the proof or after its teardown.
edge_classes=(forwarding-rules addresses backend-services url-maps target-http-proxies
  target-https-proxies network-endpoint-groups security-policies ssl-certificates logging-exclusions
  sink-exclusions)
declared_repository_description="Workspace container images, deployed by digest."
plan_log="${proof_dir}/plan.log"
# How long a delivered release may take to report every service Ready with
# all its traffic on the new revisions.
: "${SANDBOX_SERVING_TIMEOUT_SECONDS:=300}"

# ---------------------------------------------------------------- helpers

fail() {
  echo "::error::$*" >&2
  exit 1
}
notice() { echo "::notice::$*" >&2; }
warning() { echo "::warning::$*" >&2; }

trace() {
  local line="+"
  local arg
  for arg in "$@"; do line+=" $(printf '%q' "$arg")"; done
  [[ -z "$marker" ]] || line="${line//"$marker"/<marker>}"
  echo "$line" >&2
}

# Run a command, or only print it in a dry run.
run() {
  trace "$@"
  $dry_run || "$@"
}

# Print a command's stdout, or the given placeholder in a dry run.
capture() {
  local placeholder="$1"
  shift
  trace "$@"
  if $dry_run; then
    printf '%s\n' "$placeholder"
  else
    "$@"
  fi
}

# Wait without sleeping in a dry run.
pause() {
  trace sleep "$1"
  $dry_run || sleep "$1"
}

# Assert equality; a dry run only shows the expectation.
expect_equal() {
  local label="$1" actual="$2" expected="$3"
  if $dry_run; then
    echo "  expect ${label} == ${expected}" >&2
    return
  fi
  [[ "$actual" == "$expected" ]] ||
    fail "${label}: expected '${expected}', found '${actual}'"
}

# One JSON value (`null` when absent); a dry run prints a placeholder.
json_get() {
  local path="$1" file="$2"
  if $dry_run; then
    printf 'DRY%s\n' "$path"
  else
    jq -r "$path" "$file"
  fi
}

# A JSON value that must be present.
json_require() {
  local value
  value="$(json_get "$1" "$2")"
  [[ -n "$value" && "$value" != null ]] || fail "missing ${1} in $(basename "$2")"
  printf '%s\n' "$value"
}

phase() { echo "== phase: $1" >&2; }

billing() {
  # Billing APIs bill quota to the caller's project unless told otherwise.
  trace env "CLOUDSDK_BILLING_QUOTA_PROJECT=${project_id}" gcloud billing "$@"
  $dry_run || CLOUDSDK_BILLING_QUOTA_PROJECT="$project_id" gcloud billing "$@"
}

# GET one Google API resource. The bearer token goes to curl on stdin, so it
# is never traced or visible in the process list; any HTTP error fails. A dry
# run prints the placeholder.
google_get() {
  local placeholder="$1" url="$2"
  trace curl -fsS "$url" "(bearer from gcloud, never printed)"
  if $dry_run; then
    printf '%s\n' "$placeholder"
    return 0
  fi
  local token
  token="$(gcloud auth print-access-token)" || return 1
  printf 'Authorization: Bearer %s\n' "$token" |
    curl -fsS --max-time 30 -H @- "$url"
}

# The project's log exclusions as a JSON array, from the Logging API: the
# pinned SDK has no `gcloud logging exclusions` group. A second page fails
# rather than being ignored.
project_exclusions_json() {
  local body
  body="$(google_get '{"exclusions":[]}' \
    "https://logging.googleapis.com/v2/projects/${project_id}/exclusions?pageSize=100")" ||
    return 1
  if $dry_run; then
    echo '[]'
    return 0
  fi
  jq -e '.nextPageToken == null' >/dev/null <<<"$body" || return 1
  jq -c '.exclusions // []' <<<"$body"
}

# Every log sink of one parent (projects/ID, folders/ID or organizations/ID)
# as a JSON array, from the Logging API page by page: `gcloud logging sinks
# list` in the pinned SDK sends one request and drops nextPageToken
# (surface/logging/sinks/list.py), so a sink on a later page would go
# unseen. Each response must be exactly one JSON object (`{}` is an empty
# page); anything else, or more than 20 pages (2,000 sinks), fails. Pages
# reach jq on stdin, never as arguments, so no list outgrows ARG_MAX.
log_sinks_json() {
  local parent="$1" body url page_token="" count=0 pages=""
  while true; do
    url="https://logging.googleapis.com/v2/${parent}/sinks?pageSize=100"
    [[ -z "$page_token" ]] || url+="&pageToken=${page_token}"
    body="$(google_get '{"sinks":[]}' "$url")" || return 1
    jq -se 'length == 1 and (.[0] | type == "object"
      and ((.sinks // []) | type == "array")
      and ((.nextPageToken // "") | type == "string"))' >/dev/null <<<"$body" || return 1
    pages+="${body}"$'\n'
    page_token="$(jq -r '.nextPageToken // empty | @uri' <<<"$body")" || return 1
    [[ -n "$page_token" ]] || break
    count=$((count + 1))
    ((count < 20)) || return 1
  done
  jq -cs '[.[] | (.sinks // [])[]]' <<<"$pages"
}

# The project's own sinks as `name<TAB>destination` rows, every page.
project_sink_rows() {
  local sinks
  sinks="$(log_sinks_json "projects/${project_id}")" || return 1
  $dry_run || jq -r '.[] | [.name, .destination] | @tsv' <<<"$sinks"
}

# The names of one Compute collection in every region, zone and global
# scope of the project, from its aggregatedList pages. gcloud drops a
# response's top-level `unreachables` and exits 0, so the raw pages are
# read: partial success is not requested, and any warning but an empty
# page's, at page or scope level, any unreachable scope, a malformed page
# or more than 20 pages fails rather than reading as empty.
compute_names() {
  local collection="$1" body url page_token="" pages="" count=0
  while true; do
    url="https://compute.googleapis.com/compute/v1/projects/${project_id}/aggregated/${collection}?maxResults=500&returnPartialSuccess=false"
    [[ -z "$page_token" ]] || url+="&pageToken=${page_token}"
    body="$(google_get '{"items":{}}' "$url")" || return 1
    jq -se --arg collection "$collection" '
      # A warning, when present at all, must be NO_RESULTS_ON_PAGE.
      def quiet: (has("warning") | not)
        or (.warning | type == "object" and .code == "NO_RESULTS_ON_PAGE");
      length == 1 and (.[0] | type == "object"
        and ((has("items") | not) or (.items | type == "object"))
        and ((has("unreachables") | not) or (.unreachables == []))
        and ((has("nextPageToken") | not) or (.nextPageToken | type == "string"))
        and quiet
        and all((.items // {})[]; type == "object"
          and quiet
          and ((has($collection) | not) or (.[$collection] | type == "array"
            and all(.[]; type == "object" and (.name | type == "string"))))))' \
      >/dev/null 2>&1 <<<"$body" || return 1
    pages+="${body}"$'\n'
    page_token="$(jq -r '.nextPageToken // empty | @uri' <<<"$body")" || return 1
    [[ -n "$page_token" ]] || break
    count=$((count + 1))
    ((count < 20)) || return 1
  done
  $dry_run || jq -r --arg collection "$collection" '(.items // {})[] | (.[$collection] // [])[] | .name' <<<"$pages"
}

# Every exclusion on any of the project's sinks as `sink<TAB>exclusion`
# rows: the project exclusions API covers only _Default.
project_sink_exclusion_rows() {
  local sinks
  sinks="$(log_sinks_json "projects/${project_id}")" || return 1
  $dry_run || jq -r '.[] | .name as $sink | (.exclusions // [])[] | [$sink, .name] | @tsv' <<<"$sinks"
}

project_exclusion_names() {
  local exclusions
  exclusions="$(project_exclusions_json)" || return 1
  $dry_run || jq -r '.[] | .name' <<<"$exclusions"
}

# A token's expiry from Google's tokeninfo, in epoch seconds: the reported
# lifetime counted from before the request, so a slow reply only makes it
# earlier. The token goes in the request body, never on a command line.
token_expiry() {
  local start seconds
  start="$(date +%s)"
  seconds="$(printf '%s' "$1" |
    curl -sS --fail-with-body --data-urlencode 'access_token@-' \
      https://oauth2.googleapis.com/tokeninfo | jq -r '.expires_in // empty')" || return 1
  [[ "$seconds" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$((start + seconds))"
}

# Alchemy beta.87 rejects federated credential files, so it gets a bearer
# token (google-github-actions/auth `token_format: access_token`). The token
# lives at most one hour. Every phase that runs Alchemy starts with at
# least its 30-minute budget (the longest, the stack destroy) left: a
# token's expiry is its own, from tokeninfo, never an estimate, and a token
# closer to it is replaced by a fresh one from the federated gcloud
# credentials, masked before use. An empty gcloud config has no token
# cache, so gcloud cannot hand back a cached token near its expiry.
ensure_alchemy_token() {
  if $dry_run; then
    echo "+ (GOOGLE_ACCESS_TOKEN from token_format: access_token; refreshed under 30 minutes left)" >&2
    return
  fi
  local expires_at="${GOOGLE_ACCESS_TOKEN_EXPIRES_AT:-}" now
  if ! [[ "$expires_at" =~ ^[0-9]+$ ]]; then
    # The workflow's token: an unreadable lifetime counts as expired.
    if [[ -z "${GOOGLE_ACCESS_TOKEN:-}" ]] ||
      ! expires_at="$(token_expiry "$GOOGLE_ACCESS_TOKEN")"; then
      expires_at=0
    fi
  fi
  # Read after any lookup, so its time counts against the token.
  now="$(date +%s)"
  if [[ -z "${GOOGLE_ACCESS_TOKEN:-}" ]] || ((expires_at - now < 1800)); then
    local config
    config="$(mktemp -d)"
    GOOGLE_ACCESS_TOKEN="$(CLOUDSDK_CONFIG="$config" gcloud auth print-access-token)"
    rm -rf "${config:?}"
    [[ "${GITHUB_ACTIONS:-}" != true ]] || echo "::add-mask::${GOOGLE_ACCESS_TOKEN}"
    expires_at="$(token_expiry "$GOOGLE_ACCESS_TOKEN")" ||
      fail "the minted access token's lifetime is unreadable"
    now="$(date +%s)"
    ((expires_at - now >= 1800)) ||
      fail "the minted access token expires in $((expires_at - now)) s, under the 30-minute step budget"
  fi
  GOOGLE_ACCESS_TOKEN_EXPIRES_AT="$expires_at"
  export GOOGLE_ACCESS_TOKEN GOOGLE_ACCESS_TOKEN_EXPIRES_AT
}

stack_config_file="${proof_dir}/stack-config.json"
digests_file="${proof_dir}/digests.env"
releases_file="${proof_dir}/releases.env"
services_file="${proof_dir}/services.env"
telemetry_file="${proof_dir}/telemetry.env"
# The proof run's disposable queue ID suffix, kept in the state bucket
# outside the stack prefix so a later cleanup-only run declares the same
# queues. Removed with the stack.
proof_run_file="${proof_dir}/proof-run.env"
proof_run_object="sandbox-proof/run.env"
# The writer-lock holder whose processes the interrupt phase proved dead.
dead_holder_file="${proof_dir}/interrupted-dead-holder"
# Hosted proof starts only this long before the teardown deadline, leaving
# time for its own teardown and a cleanup-only rerun.
hosted_proof_teardown_margin_seconds=86400

# Read KEY=value records as data, never as shell: the proof run record comes
# back from the state bucket. Only upper-case keys with plain values (what
# record_value writes for digests, IDs, addresses and suffixes) are accepted.
load_env_file() {
  local file="$1" line key value name="${1##*/}"
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$line" == *=* && "$key" =~ ^[A-Z][A-Z0-9_]*$ && "$value" =~ ^[A-Za-z0-9._:/@+-]*$ ]] ||
      fail "${name} holds a record that is not a plain KEY=value"
    declare -g "${key}=${value}"
  done <"$file"
}

# The proof run record comes back from the state bucket, so it sets nothing
# but the queue suffix: when present it must be exactly one valid
# QUEUE_SUFFIX line, checked whole before anything is assigned.
load_proof_run_file() {
  [[ -f "$proof_run_file" ]] || return 0
  local -a lines
  mapfile -t lines < <(grep -v '^$' "$proof_run_file")
  ((${#lines[@]} == 1)) && [[ "${lines[0]}" =~ ^QUEUE_SUFFIX=(r[0-9]{1,20}-[0-9]{1,4})$ ]] ||
    fail "the proof run record is not exactly one valid QUEUE_SUFFIX"
  QUEUE_SUFFIX="${BASH_REMATCH[1]}"
}

record_value() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  grep -v "^${key}=" "$file" >"${file}.next" || true
  printf '%s=%q\n' "$key" "$value" >>"${file}.next"
  mv "${file}.next" "$file"
}

# The sandbox stack config, generated from the verified identity and decoded
# with the package's own schema before any use.
write_stack_config() {
  load_proof_run_file
  trace bun scripts/sandbox-stack-config.ts
  (
    cd "$package_dir"
    SANDBOX_PROJECT_ID="$project_id" \
      SANDBOX_PROJECT_NUMBER="${SANDBOX_EXPECTED_PROJECT_NUMBER}" \
      SANDBOX_REGION="$region" \
      SANDBOX_STATE_BUCKET="$state_bucket" \
      SANDBOX_QUEUE_SUFFIX="${QUEUE_SUFFIX:-}" \
      SANDBOX_STACK_CONFIG_DRY_RUN="$dry_run" \
      bun scripts/sandbox-stack-config.ts
  ) >"${stack_config_file}.next"
  mv "${stack_config_file}.next" "$stack_config_file"
}

use_stack_config() {
  [[ -f "$stack_config_file" ]] || write_stack_config
  WORKSPACE_STACK_CONFIG="$(cat "$stack_config_file")"
  export WORKSPACE_STACK_CONFIG
}

# `bun run release <command>` as the stage's only writer.
release() {
  use_stack_config
  trace bun run release "$@"
  $dry_run || (cd "$package_dir" && bun release.run.ts "$@")
}

dry_status='{"version":"1","record":{"generation":1,"writer":null,"pendingApply":null}}'

# `release status` into a named artifact file; prints the file path. Its
# stdout must be the one JSON record: logs go to stderr, and anything else
# fails here rather than reading as an absent lock.
release_status() {
  local file="${proof_dir}/status-$1.json"
  use_stack_config
  trace bun run release status
  if $dry_run; then
    printf '%s\n' "$dry_status" >"$file"
  else
    (cd "$package_dir" && bun release.run.ts status) >"$file" ||
      fail "release status failed; see $(basename "$file")"
    jq -se 'length == 1 and (.[0].record | type == "object")' "$file" >/dev/null 2>&1 ||
      fail "release status printed no single JSON record; see $(basename "$file")"
  fi
  printf '%s\n' "$file"
}

# Writer-locked Alchemy commands the release command has no verb for.
locked_stack() {
  use_stack_config
  trace bun scripts/sandbox-locked-stack.ts "$@"
  $dry_run && return 0
  (cd "$package_dir" && bun scripts/sandbox-locked-stack.ts "$@")
}

expect_settled() {
  local status="$1" digest="${2:-}"
  expect_equal "writer lock" "$(json_get '.record.writer' "$status")" null
  expect_equal "pending apply" "$(json_get '.record.pendingApply' "$status")" null
  if [[ -n "$digest" ]]; then
    expect_equal "active digest" "$(json_require '.record.active.imageDigest' "$status")" "$digest"
  fi
}

# `release plan` must report no changes. Alchemy's plan goes to stderr, with
# every log, so both streams are read.
expect_no_op_plan() {
  release plan 2>&1 | tee "$plan_log" >&2
  $dry_run && {
    echo "  expect plan summary: no changes" >&2
    return
  }
  local summary
  summary="$(sed 's/\x1b\[[0-9;]*m//g' "$plan_log")"
  if grep -Eq '[0-9]+ to (create|update|replace|delete|adopted|orphaned)' <<<"$summary"; then
    fail "release plan is not a no-op; see the plan log"
  fi
  grep -q 'no changes' <<<"$summary" ||
    fail "release plan printed no recognizable summary"
}

# Lowercase hex from the kernel's random source: $1 bytes.
random_hex() {
  od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
}

# The private directory: outside the uploaded proof directory, readable by
# the runner's user alone.
ensure_private_dir() {
  local private proof
  private="$(realpath -m "$private_dir")"
  proof="$(realpath -m "$proof_dir")"
  [[ "${private}/" != "${proof}/"* ]] ||
    fail "SANDBOX_PROOF_PRIVATE_DIR must lie outside the uploaded proof directory"
  (umask 077 && mkdir -p "$private_dir")
  chmod 700 "$private_dir"
}

# The run's synthetic marker, kept in the private directory. Only the
# primary RPC probe creates it (`load_marker create`), first discarding any
# earlier attempt's record; its digest is recorded with the probe's trace
# and start only once the probe passed. Every later phase must find that
# very marker, so a lost marker, or one from a failed attempt, can never
# stand in for the one the RPC received. Masked in a GitHub job log;
# trace() redacts it and no check prints it.
load_marker() {
  ensure_private_dir
  if [[ "${1:-}" == create ]]; then
    rm -f "$telemetry_file"
    unset MARKER_SHA256 PROBE_STARTED_AT PROBE_TRACE_ID
    (umask 077 && printf 'sandbox-marker-%s' "$(random_hex 16)" >"$marker_file")
  fi
  [[ -s "$marker_file" ]] || fail "the run's marker is missing; only the rpc-probe phase creates it"
  marker="$(cat "$marker_file")"
  [[ "$marker" =~ ^sandbox-marker-[0-9a-f]{32}$ ]] || fail "the private marker file is malformed"
  [[ "${GITHUB_ACTIONS:-}" != true ]] || echo "::add-mask::${marker}"
  [[ "${1:-}" != create ]] || return 0
  load_env_file "$telemetry_file"
  [[ -n "${MARKER_SHA256:-}" && "$(marker_sha256)" == "$MARKER_SHA256" ]] ||
    fail "the private marker is not the one the rpc-probe phase sent"
}

# Lowercase hex SHA-256 of the marker's UTF-8 bytes, as the probe logs it.
marker_sha256() {
  printf '%s' "$marker" | sha256sum | cut -d' ' -f1
}

# A JWT's claims, decoded from its base64url payload; fails unless they
# are one JSON object.
jwt_claims() {
  local payload
  payload="$(cut -d. -f2 <"$1" | tr '_-' '/+')"
  while ((${#payload} % 4)); do payload+="="; done
  base64 -d <<<"$payload" 2>/dev/null | jq -ce 'select(type == "object")'
}

# The workspace-api ID token the workflow minted for this step
# (google-github-actions/auth `token_format: id_token`), moved from the
# environment into the private token file before any command runs, and
# removed when the runner exits. Its audience must be the recorded
# workspace-api URL and it must outlive the given seconds: an ID token
# lives one hour and is never refreshed here, so a later step gets its own.
load_id_token() {
  local min_seconds="$1" url="$2" claims expires now
  ensure_private_dir
  if $dry_run; then
    echo "+ (SANDBOX_API_ID_TOKEN to the private token file; audience ${url}; at least ${min_seconds} s left)" >&2
    return
  fi
  [[ -n "${SANDBOX_API_ID_TOKEN:-}" ]] ||
    fail "no workspace-api ID token: the workflow mints one with token_format: id_token before this step"
  (umask 077 && printf '%s' "$SANDBOX_API_ID_TOKEN" >"$id_token_file")
  unset SANDBOX_API_ID_TOKEN
  claims="$(jwt_claims "$id_token_file")" || fail "the workspace-api ID token is not a readable JWT"
  [[ "$(jq -r '.aud // empty' <<<"$claims")" == "$url" ]] ||
    fail "the ID token's audience is not the workspace-api URL ${url}"
  expires="$(jq -r '.exp // empty' <<<"$claims")"
  now="$(date +%s)"
  if ! [[ "$expires" =~ ^[0-9]+$ ]] || ((expires - now < min_seconds)); then
    fail "the workspace-api ID token expires in under ${min_seconds} s; this step needs a freshly minted one"
  fi
}

# The proof record key of each release service's URL.
service_url_key() {
  case "$1" in
    "$api_service") echo API_URL ;;
    "$tasks_worker_service") echo TASKS_WORKER_URL ;;
    "$scheduler_worker_service") echo SCHEDULER_WORKER_URL ;;
    *) fail "${1} is no release service" ;;
  esac
}

# Each release service's run.app URL, read back after the first deliver.
# The workspace-api URL is the step's `api_url` output: the audience every
# later ID token is minted for.
# The stack aims queues, jobs and ID-token audiences at each service's
# deterministic URL (https://<service>-<project number>.<region>.run.app);
# the service must report it among its URLs.
record_service_urls() {
  local service url described
  for service in "${release_services[@]}"; do
    url="https://${service}-${SANDBOX_EXPECTED_PROJECT_NUMBER}.${region}.run.app"
    described="$(capture "{\"status\":{\"url\":\"${url}\"}}" gcloud run services describe "$service" \
      --project="$project_id" --region="$region" --format=json)" ||
      fail "the URLs of ${service} are unreadable"
    jq -e --arg url "$url" '.status.url == $url
      or ((.metadata.annotations["run.googleapis.com/urls"] // "[]") | fromjson | index($url)) != null' \
      >/dev/null 2>&1 <<<"$described" || fail "${service} does not report its deterministic URL ${url}"
    record_value "$services_file" "$(service_url_key "$service")" "$url"
  done
  load_env_file "$services_file"
  [[ -z "${GITHUB_OUTPUT:-}" ]] || echo "api_url=${API_URL}" >>"$GITHUB_OUTPUT"
}

service_url() {
  local key
  key="$(service_url_key "$1")"
  load_env_file "$services_file"
  if [[ -z "${!key:-}" ]]; then
    $dry_run || fail "no recorded URL for ${1}; deliver-v1 records them"
    echo "https://${1}-759037106024.${region}.run.app"
    return
  fi
  echo "${!key}"
}

# Whether one service is Ready and sends all its traffic to revisions
# running the given image digest. Every read must succeed.
service_serves() {
  local service="$1" digest="$2" described revision image
  local -a revisions
  described="$(gcloud run services describe "$service" --project="$project_id" \
    --region="$region" --format=json 2>/dev/null)" || return 1
  jq -e 'any(.status.conditions[]?; .type == "Ready" and .status == "True")
    and .status.observedGeneration != null
    and .status.observedGeneration == .metadata.generation
    and ([.status.traffic[]? | .percent // 0] | add) == 100
    and all(.status.traffic[]? | select((.percent // 0) > 0); (.revisionName // "") != "")' \
    >/dev/null 2>&1 <<<"$described" || return 1
  mapfile -t revisions < <(jq -r '.status.traffic[] | select((.percent // 0) > 0) | .revisionName' <<<"$described")
  ((${#revisions[@]} > 0)) || return 1
  for revision in "${revisions[@]}"; do
    image="$(gcloud run revisions describe "$revision" --project="$project_id" \
      --region="$region" --format='value(status.imageDigest)' 2>/dev/null)" || return 1
    [[ "$image" == "$digest" || "$image" == *"@${digest}" ]] || return 1
  done
}

# Cloud Run readback of a release: every release service is Ready and
# sends 100% of its traffic to revisions of the given probe build. The
# services are IAM-private, so this needs no request through them; the
# RPC probe proves the data path with an ID token where one is minted.
expect_released() {
  local version="$1" key digest service deadline
  key="PROBE_${version^^}_DIGEST"
  load_env_file "$digests_file"
  digest="${!key:-}"
  if $dry_run; then
    for service in "${release_services[@]}"; do
      trace gcloud run services describe "$service" --project="$project_id" --region="$region" --format=json
    done
    echo "  expect every release service Ready with 100% of its traffic on probe ${version}" >&2
    return
  fi
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "no recorded digest for probe ${version}"
  deadline=$(($(date +%s) + SANDBOX_SERVING_TIMEOUT_SECONDS))
  for service in "${release_services[@]}"; do
    until service_serves "$service" "$digest"; do
      (($(date +%s) < deadline)) ||
        fail "${service} did not send all its traffic to Ready revisions of probe ${version} within ${SANDBOX_SERVING_TIMEOUT_SECONDS} s"
      sleep 10
    done
  done
  echo "every release service sends 100% of its traffic to probe ${version}"
}

# Repeated Cloud Logging reads until the filter matches: Logging must stay
# readable, and a match must not carry the raw marker. Nothing read is
# printed.
wait_for_log() {
  local label="$1" filter="$2" entries
  for _ in $(seq 1 16); do
    entries="$(capture '[{"jsonPayload":{}}]' gcloud logging read "$filter" --project="$project_id" \
      --freshness=1h --limit=5 --format=json)" ||
      fail "Cloud Logging is unreadable; ${label} is unverified"
    if jq -e 'type == "array" and length > 0' >/dev/null 2>&1 <<<"$entries"; then
      [[ -z "$marker" || "$entries" != *"$marker"* ]] || fail "${label} carries the raw marker"
      echo "found ${label}"
      return 0
    fi
    $dry_run && return 0
    pause 15
  done
  fail "no ${label} within four minutes"
}

# One state-bucket object's live metadata from the Cloud Storage JSON API,
# as JSON with the requested fields, or "absent" only when the service
# answers 404 "No such object" for this very object. An authentication,
# transport or any other error fails, so an unreadable object never reads
# as a missing or unchanged one.
storage_object() {
  local name="$1" fields="$2" url response code body token
  url="https://storage.googleapis.com/storage/v1/b/${state_bucket}/o/$(jq -rn --arg name "$name" '$name | @uri')?fields=${fields}"
  token="$(gcloud auth print-access-token)" || return 1
  [[ -n "$token" ]] || return 1
  response="$(printf 'Authorization: Bearer %s\n' "$token" |
    curl -sS --max-time 30 -H @- -w '\n%{http_code}' "$url")" || return 1
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$code" in
    200)
      jq -ce . <<<"$body" 2>/dev/null || return 1
      ;;
    404)
      jq -e --arg object "${state_bucket}/${name}" \
        '.error.code == 404 and (.error.message == "No such object: \($object)")' \
        >/dev/null <<<"$body" 2>/dev/null || return 1
      echo absent
      ;;
    *) return 1 ;;
  esac
}

# An object's live generation, or "absent"; fails when unreadable.
object_generation() {
  local object generation
  trace curl -sS "https://storage.googleapis.com/storage/v1/b/${state_bucket}/o/<$1>?fields=generation" \
    "(bearer from gcloud, never printed)"
  if $dry_run; then
    echo 1
    return 0
  fi
  object="$(storage_object "$1" generation)" || return 1
  if [[ "$object" == absent ]]; then
    echo absent
    return 0
  fi
  generation="$(jq -r '.generation // empty' <<<"$object")"
  [[ "$generation" =~ ^[0-9]+$ ]] || return 1
  echo "$generation"
}

# No Alchemy lease holder: a live holder refreshes the 60 s lease well
# within a minute, so an unchanged generation over 65 s means none. An
# unreadable lease fails rather than counting as quiet.
wait_for_quiet_lease() {
  local before after
  before="$(object_generation "$lease_object")" ||
    fail "the Alchemy lease is unreadable; a live holder cannot be ruled out"
  pause 65
  after="$(object_generation "$lease_object")" ||
    fail "the Alchemy lease is unreadable; a live holder cannot be ruled out"
  expect_equal "Alchemy lease generation over 65 s" "$after" "$before"
}

# List one resource class into an inventory file. A denied or failed list
# is recorded as unverified, never as empty.
inventory_class() {
  local dir="$1" class="$2"
  shift 2
  trace "$@"
  $dry_run && return 0
  # Aggregated gcloud lists report an unreachable scope as a warning on
  # stderr and still exit 0: a partial listing is no listing.
  if "$@" >"${dir}/${class}.txt" 2>"${dir}/${class}.err" &&
    ! grep -Eqi '(^|[[:space:]])(WARNING|ERROR):|did not succeed|could not fetch|unreachable' "${dir}/${class}.err"; then
    rm -f "${dir}/${class}.err"
  else
    echo "UNVERIFIED" >"${dir}/${class}.txt"
    notice "${class}: listing failed or was partial (permission, API or scope); unverified, not empty"
  fi
}

take_inventory() {
  local dir="${proof_dir}/inventory-$1"
  mkdir -p "$dir"
  local p=(--project="$project_id")
  inventory_class "$dir" run-services gcloud run services list "${p[@]}" --region="$region" --format='value(metadata.name)'
  inventory_class "$dir" run-revisions gcloud run revisions list "${p[@]}" --region="$region" --format='value(metadata.name)'
  inventory_class "$dir" artifact-repositories gcloud artifacts repositories list "${p[@]}" --location="$region" --format='value(name)'
  inventory_class "$dir" forwarding-rules compute_names forwardingRules
  inventory_class "$dir" addresses compute_names addresses
  inventory_class "$dir" backend-services compute_names backendServices
  inventory_class "$dir" url-maps compute_names urlMaps
  inventory_class "$dir" target-http-proxies compute_names targetHttpProxies
  inventory_class "$dir" target-https-proxies compute_names targetHttpsProxies
  inventory_class "$dir" network-endpoint-groups compute_names networkEndpointGroups
  inventory_class "$dir" security-policies compute_names securityPolicies
  inventory_class "$dir" ssl-certificates compute_names sslCertificates
  inventory_class "$dir" logging-exclusions project_exclusion_names
  inventory_class "$dir" logging-sinks project_sink_rows
  inventory_class "$dir" sink-exclusions project_sink_exclusion_rows
  inventory_class "$dir" tasks-queues gcloud tasks queues list "${p[@]}" --location="$region" --format='value(name)'
  inventory_class "$dir" scheduler-jobs gcloud scheduler jobs list "${p[@]}" --location="$region" --format='value(name)'
  inventory_class "$dir" storage-buckets gcloud storage buckets list "${p[@]}" --format='value(name)'
  # The stack grants roles/run.invoker per service only; a project-level
  # grant of it is a leak, and none outlives the services.
  inventory_class "$dir" project-run-invokers gcloud projects get-iam-policy "$project_id" \
    --flatten='bindings[].members' --filter='bindings.role=roles/run.invoker' --format='value(bindings.members)'
  inventory_class "$dir" state-objects gcloud storage ls -r "gs://${state_bucket}/"
}

# What counts as a proof resource in each class. The shared state bucket,
# WIF, deployer and release record history are preserved by design and not
# matched.
proof_pattern() {
  case "$1" in
    run-services | run-revisions) echo '^workspace-' ;;
    # `value(name)` lists the bare repository ID.
    artifact-repositories) echo "(^|/repositories/)${artifact_repository}\$" ;;
    # Load balancers, NEGs, Cloud Armor, certificates and log exclusions:
    # any at all, and any project-level invoker grant.
    forwarding-rules | addresses | backend-services | url-maps | target-http-proxies | target-https-proxies | network-endpoint-groups | security-policies | ssl-certificates | logging-exclusions | sink-exclusions | project-run-invokers)
      echo '.' ;;
    # `value(name)` lists bare queue and job IDs.
    tasks-queues | scheduler-jobs) echo '(^|/)workspace-' ;;
    storage-buckets) echo "^(gs://)?${mobile_updates_bucket}/?\$" ;;
    # Objects only: `storage ls -r` also prints each folder as a
    # `gs://…/prefix/:` heading, which is no residue.
    # The release record's live object too; its noncurrent generations are
    # history, which `ls -r` does not list.
    state-objects) echo "${stack_prefix}[^_:][^:]*\$|/${proof_run_object}\$|/${record_object}\$" ;;
    *) echo '^$' ;;
  esac
}

proof_residuals() {
  local class="$1" pattern="$2" file="$3"
  case "$class" in
    run-services)
      # The backend preview pilot has its own Alchemy state and teardown.
      grep -E "$pattern" "$file" | grep -Ev '^workspace-(api|tasks|scheduler)-preview$'
      ;;
    run-revisions)
      grep -E "$pattern" "$file" | grep -Ev '^workspace-(api|tasks|scheduler)-preview-(seed|g-[a-f0-9]{16})$'
      ;;
    *) grep -E "$pattern" "$file" ;;
  esac
}

# ---------------------------------------------------------------- phases

# Before authenticating: mutating modes only on main, only against the
# approved sandbox identifiers.
phase_guard() {
  case "${SANDBOX_PROOF_MODE:-}" in
    hosted-proof | cleanup-only) ;;
    *) fail "guard is only for the hosted-proof and cleanup-only modes" ;;
  esac
  [[ "${GITHUB_REF:-}" == "refs/heads/main" ]] ||
    fail "mutating sandbox modes run only from refs/heads/main"
  [[ "$project_id" == "${SANDBOX_EXPECTED_PROJECT_ID:-}" ]] ||
    fail "GCP_SANDBOX_PROJECT_ID is not the approved sandbox project"
  [[ "$state_bucket" == "${SANDBOX_EXPECTED_STATE_BUCKET:-}" ]] ||
    fail "GCP_SANDBOX_STATE_BUCKET is not the approved sandbox state bucket"
  [[ "$region" == "europe-west1" ]] || fail "the sandbox region is europe-west1"
  [[ "${SANDBOX_EXPECTED_PROJECT_NUMBER:-}" =~ ^[1-9][0-9]{5,19}$ ]] ||
    fail "SANDBOX_EXPECTED_PROJECT_NUMBER is not a project number"
  [[ "${GCP_SANDBOX_DEPLOY_SA:-}" == "workspace-deployer@${project_id}.iam.gserviceaccount.com" ]] ||
    fail "GCP_SANDBOX_DEPLOY_SA is not the sandbox deployer"
  echo "guard passed for ${SANDBOX_PROOF_MODE} on ${GITHUB_REF}"
}

# After authenticating: the live project number and bucket region match,
# then the decoded stack config is written.
phase_preflight() {
  local number location
  number="$(capture "$SANDBOX_EXPECTED_PROJECT_NUMBER" gcloud projects describe "$project_id" --format='value(projectNumber)')"
  expect_equal "project number" "$number" "$SANDBOX_EXPECTED_PROJECT_NUMBER"
  location="$(capture "$region" gcloud storage buckets describe "gs://${state_bucket}" --format='value(location)')"
  expect_equal "state bucket location" "${location,,}" "$region"
  if [[ ! -f "$proof_run_file" ]] &&
    ! run gcloud storage cp "gs://${state_bucket}/${proof_run_object}" "$proof_run_file"; then
    notice "no recorded proof run; queue IDs come from Alchemy state alone"
  fi
  write_stack_config
  check_teardown_window
}

# The stack config's teardown deadline bounds the proof: hosted-proof must
# start at least a day before it; cleanup-only runs at any time.
check_teardown_window() {
  local teardown_at deadline now latest_start
  teardown_at="$(jq -r '.budget.teardownAt // empty' "$stack_config_file")"
  [[ -n "$teardown_at" ]] || fail "the sandbox stack config records no teardown deadline"
  deadline="$(date -u -d "$teardown_at" +%s)" || fail "unreadable teardown deadline ${teardown_at}"
  now="$(date -u +%s)"
  latest_start=$((deadline - hosted_proof_teardown_margin_seconds))
  if [[ "${SANDBOX_PROOF_MODE:-}" == hosted-proof ]] && ((now > latest_start)); then
    fail "hosted-proof must start by $(date -u -d "@${latest_start}" +%Y-%m-%dT%H:%M:%SZ), a day before the ${teardown_at} teardown deadline; only cleanup-only may run now"
  fi
  if ((now > deadline)); then
    warning "the ${teardown_at} teardown deadline has passed; tear the sandbox down"
  fi
  echo "teardown deadline ${teardown_at}; ${SANDBOX_PROOF_MODE:-this mode} may run"
}

# Read-only: billing link, enabled APIs the proof needs, log routing.
phase_readonly_inventory() {
  billing projects describe "$project_id" --format='value(billingEnabled,billingAccountName)' ||
    notice "billing link unverified (denied)"
  local enabled api
  if enabled="$(capture "" gcloud services list --enabled --project="$project_id" --format='value(config.name)')"; then
    for api in run.googleapis.com artifactregistry.googleapis.com cloudtasks.googleapis.com \
      cloudscheduler.googleapis.com logging.googleapis.com monitoring.googleapis.com \
      cloudtrace.googleapis.com secretmanager.googleapis.com sts.googleapis.com \
      iamcredentials.googleapis.com; do
      if $dry_run; then
        continue
      elif grep -qx "$api" <<<"$enabled"; then
        echo "enabled: ${api}"
      else
        notice "not enabled: ${api}"
      fi
    done
  else
    notice "enabled APIs unverified (denied)"
  fi
  # Name, destination and the routing filter, `(empty filter)` as gcloud
  # shows a sink that routes every log.
  local sinks
  if sinks="$(log_sinks_json "projects/${project_id}")"; then
    $dry_run || jq -r '.[] | [.name, .destination, (.filter // "" | if . == "" then "(empty filter)" else . end)] | @tsv' <<<"$sinks"
  else
    notice "log sinks unverified (denied); inherited folder/organization sinks are not listed"
  fi
  local exclusions
  if exclusions="$(project_exclusions_json)"; then
    $dry_run || jq -r '.[] | [.name, (.disabled // false), .filter] | @tsv' <<<"$exclusions"
  else
    notice "log exclusions unverified (denied)"
  fi
}

# The baseline must prove the project holds no load balancer, NEG, Cloud
# Armor policy, certificate or log exclusion: an unreadable class fails.
phase_baseline_inventory() {
  take_inventory baseline
  if $dry_run; then
    echo "  expect none of: ${edge_classes[*]}" >&2
    return
  fi
  local dir="${proof_dir}/inventory-baseline" class found=false
  for class in "${edge_classes[@]}"; do
    [[ "$(cat "${dir}/${class}.txt")" != UNVERIFIED ]] ||
      fail "${class} is unreadable; the baseline cannot prove the project has none"
    if grep -q . "${dir}/${class}.txt"; then
      found=true
      echo "::error::the project already holds ${class}: $(tr '\n' ' ' <"${dir}/${class}.txt")"
    fi
  done
  ! $found || fail "the project holds resources the IAM-private topology must not need"
  echo "no load balancer, NEG, Cloud Armor policy, certificate or log exclusion exists"
}

phase_foundation() {
  # Cloud Tasks keeps a deleted queue's ID unavailable for days, so every
  # proof run declares queues of its own, recorded before Alchemy creates
  # any for cleanup and recovery.
  record_value "$proof_run_file" QUEUE_SUFFIX "r${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  run gcloud storage cp "$proof_run_file" "gs://${state_bucket}/${proof_run_object}"
  write_stack_config
  # An empty record declares no release-owned service: foundation only.
  release deploy
}

build_and_push() {
  local key="$1" image="$2" tag="$3" dockerfile="$4" context="$5"
  shift 5
  local reference="${region}-docker.pkg.dev/${project_id}/${artifact_repository}/${image}:${tag}"
  local metadata="${proof_dir}/build-${key}.json"
  run docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --push --metadata-file "$metadata" --tag "$reference" --file "$dockerfile" "$@" "$context"
  local digest
  if $dry_run; then
    digest="sha256:$(printf '%064d' "${#key}")"
  else
    digest="$(jq -r '."containerimage.digest"' "$metadata")"
  fi
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "no pushed digest for ${key}"
  record_value "$digests_file" "$key" "$digest"
  echo "${key}=${digest}"
}

# Build the same Workspace API source as three release candidates. Archive the
# checked-out commit, so runner credentials and untracked files stay outside
# Docker's build context.
phase_images() (
  run gcloud auth configure-docker "${region}-docker.pkg.dev" --quiet
  local suffix="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" context version dockerfile
  context="$(mktemp -d)"
  trap 'rm -rf "${context:?}"' EXIT
  mkdir "$context/source"
  run git -C "$repo_root" archive --format=tar --output="$context/source.tar" "$GITHUB_SHA"
  run tar -xf "$context/source.tar" -C "$context/source"
  dockerfile="$context/source/apps/deskohub-workspace-api/Dockerfile"
  for version in v1 v2 v3; do
    build_and_push "PROBE_${version^^}_DIGEST" "$probe_image" "probe-${version}-${suffix}" \
      "$dockerfile" "$context/source" --target sandbox --build-arg "PROBE_BUILD_VERSION=${version}"
  done
)

phase_deliver_v1() {
  load_env_file "$digests_file"
  release deliver --sha "$GITHUB_SHA" --image-digest "${PROBE_V1_DIGEST:-}"
  local status
  status="$(release_status after-v1)"
  expect_settled "$status" "${PROBE_V1_DIGEST:-}"
  record_value "$releases_file" V1_RELEASE_ID "$(json_require '.record.active.releaseId' "$status")"
  expect_no_op_plan
  record_service_urls
  expect_released v1
}

# One unauthenticated (or garbage-bearer) request's HTTP status, 000 when
# no response came back.
request_status() {
  local method="$1" url="$2" code
  shift 2
  local request=(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X "$method" "$@" "$url")
  trace "${request[@]}"
  if $dry_run; then
    echo 403
    return
  fi
  code="$("${request[@]}" 2>/dev/null)" || code=000
  [[ "$code" =~ ^[0-9]{3}$ ]] || code=000
  printf '%s\n' "$code"
}

# A refused request: any 2xx means the service answered without IAM.
expect_refused() {
  local label="$1" code="$2" accepted="$3"
  if $dry_run; then
    echo "  expect ${label}: HTTP ${accepted}" >&2
    return
  fi
  [[ ! "$code" =~ ^2 ]] || fail "${label} was served (HTTP ${code}); the service is not IAM-private"
  [[ "$code" =~ ^(${accepted})$ ]] || fail "${label}: HTTP ${code}, expected ${accepted}"
}

# The service's expected unconditional roles/run.invoker members and ingress.
service_invokers() {
  case "$1" in
    "$api_service") printf '%s\n' "serviceAccount:${frontend_invoker}" "serviceAccount:${GCP_SANDBOX_DEPLOY_SA:-}" ;;
    "$tasks_worker_service") printf '%s\n' "serviceAccount:${tasks_invoker}" ;;
    "$scheduler_worker_service") printf '%s\n' "serviceAccount:${scheduler_invoker}" ;;
  esac
}
# Every service keeps the default run.app ingress; IAM alone keeps it private.
service_ingress() { echo all; }

# IAM readback: no public member, exactly the expected unconditional
# invokers, the invoker IAM check on, and the expected ingress.
expect_iam_private() {
  local service="$1" policy described invokers ingress
  policy="$(capture '{"bindings":[]}' gcloud run services get-iam-policy "$service" \
    --project="$project_id" --region="$region" --format=json)" ||
    fail "the IAM policy of ${service} is unreadable"
  described="$(capture '{"metadata":{"annotations":{}}}' gcloud run services describe "$service" \
    --project="$project_id" --region="$region" --format=json)" ||
    fail "${service} is unreadable"
  ingress="$(service_ingress "$service")"
  if $dry_run; then
    echo "  expect ${service}: no public member; invokers exactly $(service_invokers "$service" | paste -sd ' '); invoker IAM check on; ingress ${ingress}" >&2
    return
  fi
  invokers="$(service_invokers "$service" | jq -Rnc '[inputs] | sort')"
  jq -e '[.bindings[]?.members[]?] | any(. == "allUsers" or . == "allAuthenticatedUsers") | not' \
    >/dev/null 2>&1 <<<"$policy" || fail "${service} grants allUsers or allAuthenticatedUsers"
  jq -e --argjson want "$invokers" '[.bindings[]? | select(.role == "roles/run.invoker")] as $grants
    | ($grants | all(.condition == null))
      and ([$grants[].members[]?] | unique) == ($want | unique)' >/dev/null 2>&1 <<<"$policy" ||
    fail "${service} does not grant roles/run.invoker unconditionally to exactly ${invokers}"
  jq -e '(.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] // "false") != "true"' \
    >/dev/null 2>&1 <<<"$described" || fail "${service} has the invoker IAM check disabled"
  jq -e --arg ingress "$ingress" '.metadata.annotations["run.googleapis.com/ingress"] == $ingress
      and .metadata.annotations["run.googleapis.com/ingress-status"] == $ingress' \
    >/dev/null 2>&1 <<<"$described" || fail "${service} does not have ingress ${ingress}, requested and active"
  echo "${service}: IAM-private"
}

# While the services are live, the project grants no public member and no
# project-wide roles/run.invoker that would bypass the service policies.
expect_project_iam_private() {
  local policy
  policy="$(capture '{"bindings":[]}' gcloud projects get-iam-policy "$project_id" --format=json)" ||
    fail "the project IAM policy is unreadable"
  $dry_run && return 0
  jq -e '[.bindings[]? | select(.role == "roles/run.invoker"
      or any(.members[]?; . == "allUsers" or . == "allAuthenticatedUsers"))] == []' \
    >/dev/null 2>&1 <<<"$policy" ||
    fail "the project grants roles/run.invoker or a public member at project level"
  echo "the project grants no project-wide invoker or public member"
}

# Every service refuses callers without roles/run.invoker, on its own
# routes too: an unauthenticated request gets 403 and a malformed bearer
# 401, from Cloud Run before the container sees it. All three keep the
# default run.app ingress, so the runner reaches IAM on each. The probe
# serves GET /health beside its startup /healthz: Cloud Run reserves some
# paths ending in z on the run.app URL.
phase_private_access() {
  local service url
  for service in "${release_services[@]}"; do
    url="$(service_url "$service")"
    expect_refused "unauthenticated GET /health on ${service}" \
      "$(request_status GET "${url}/health")" 403
    expect_refused "unauthenticated POST /rpc on ${service}" \
      "$(request_status POST "${url}/rpc" --data-binary '')" 403
    expect_refused "POST /rpc with a garbage bearer on ${service}" \
      "$(request_status POST "${url}/rpc" -H 'Authorization: Bearer garbage' --data-binary '')" 401
    case "$service" in
      "$tasks_worker_service")
        expect_refused "unauthenticated POST ${proof_queue_path} on ${service}" \
          "$(request_status POST "${url}${proof_queue_path}" --data-binary '{}')" 403
        ;;
      "$scheduler_worker_service")
        expect_refused "unauthenticated GET ${proof_schedule_path} on ${service}" \
          "$(request_status GET "${url}${proof_schedule_path}")" 403
        ;;
    esac
    expect_iam_private "$service"
  done
  expect_project_iam_private
}

# The RPC probe against workspace-api as the deployer, with the run's
# marker in the body and a fresh sampled traceparent. Its verdict, which
# holds no token and no marker, is kept as rpc-probe-<label>.json; the
# first probe's trace ID is the privacy phase's positive control.
run_rpc_probe() {
  local version="$1" label="$2" url trace_id file="${proof_dir}/rpc-probe-${2}.json" code=0 problems
  url="$(service_url "$api_service")"
  local started
  started="$(date -u +%s)"
  if [[ "$label" == primary ]]; then
    load_marker create
  else
    load_marker
  fi
  load_id_token 600 "$url"
  trace_id="$(random_hex 16)"
  [[ "$trace_id" =~ ^[0-9a-f]{32}$ && "$trace_id" != "${trace_id//?/0}" ]] || fail "no usable trace ID"
  trace bun scripts/sandbox-rpc-probe.ts --url "$url" --id-token-file "<private token file>" \
    --marker-file "<private marker file>" --traceparent "00-${trace_id}-<span>-01" --expect-version "$version" --email-preferences
  if ! $dry_run; then
    (cd "$package_dir" && bun scripts/sandbox-rpc-probe.ts --url "$url" --id-token-file "$id_token_file" \
      --marker-file "$marker_file" --traceparent "00-${trace_id}-$(random_hex 8)-01" \
      --expect-version "$version" --email-preferences) >"${file}.next" || code=$?
    if grep -qF -- "$marker" "${file}.next"; then
      rm -f "${file}.next"
      fail "the RPC probe printed the marker"
    fi
    mv "${file}.next" "$file"
    jq -se 'length == 1 and (.[0] | type == "object")' "$file" >/dev/null 2>&1 ||
      fail "the RPC probe printed no single JSON verdict (exit ${code}); see $(basename "$file")"
    problems="$(jq -r --arg sha "$(marker_sha256)" --arg version "$version" --arg type "$rpc_content_type" '
      [ if .ok != true then "verdict not ok" else empty end,
        if .status != 200 then "HTTP \(.status)" else empty end,
        if ((.contentType // "") | startswith($type)) then empty else "content type \(.contentType)" end,
        if .version != $version then "version \(.version)" else empty end,
        if .markerSha256 != $sha or .markerMatches != true then "markerSha256 does not match the local hash" else empty end,
        if .failDecoded != "ProbeRejected" then "Probe.fail decoded as \(.failDecoded)" else empty end,
        if ((.countChunks // []) | length) != 3 then "Probe.count yielded \((.countChunks // []) | length) chunks" else empty end,
        if .emailPreferences != {"opened":true,"rejected":"CampaignUnsubscribeRejected","first":"withdrawn","repeat":"unchanged"} then "email preferences proof incomplete" else empty end,
        ((.failures // [])[] | tostring)
      ] | join("; ")' "$file")"
    [[ "$code" == 0 && -z "$problems" ]] ||
      fail "the RPC probe failed (exit ${code}): ${problems:-see $(basename "$file")}"
  else
    echo "  expect HTTP 200, ${rpc_content_type}, matching markerSha256, ProbeRejected, 3 chunks, version ${version}, fresh preferences grant, typed token rejection, withdrawn and unchanged" >&2
  fi
  if [[ "$label" == primary ]]; then
    # Published together, after the verdict passed.
    record_value "$telemetry_file" PROBE_STARTED_AT "$started"
    record_value "$telemetry_file" PROBE_TRACE_ID "$trace_id"
    record_value "$telemetry_file" MARKER_SHA256 "$(marker_sha256)"
  fi
  echo "RPC probe ${label}: workspace-api serves ${version} over SchemaBinary (trace ${trace_id})"
}

phase_rpc_probe() {
  run_rpc_probe v1 primary
}

# The proof job runs on January 1 at midnight UTC. It must have been
# created after the last tick, and the next tick must fall outside the
# workflow's 15-minute worker step. Only a manual run can then deliver it.
check_proof_schedule_window() {
  local described="$1" job="$2" created now year last_tick next_tick
  created="$(jq -er 'select(.schedule == "0 0 1 1 *" and .timeZone == "Etc/UTC")
    | .userUpdateTime | strings | select(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"))' \
    <<<"$described")" && created="$(date -u -d "$created" +%s 2>/dev/null)" ||
    fail "cannot rule out a scheduled proof tick for ${job}; expected an annual UTC schedule and creation time"
  now="$(capture 1795694400 date -u +%s)" # Dry run uses 2026-11-26T12:00:00Z.
  year="$(date -u -d "@$now" +%Y)"
  last_tick="$(date -u -d "${year}-01-01" +%s)"
  next_tick="$(date -u -d "$((year + 1))-01-01" +%s)"
  ((created > last_tick && created <= now && now + 15 * 60 < next_tick)) ||
    fail "cannot rule out a scheduled proof tick for ${job} within the lifetime of the job and worker step"
}

# Pause even if resume reported an error: it might have changed the job
# before the response was lost. Read the state if pause itself fails.
restore_paused_proof_schedule() {
  local job="$1" state
  if run gcloud scheduler jobs pause "$job" --project="$project_id" \
    --location="$region" --format=none; then
    return 0
  fi
  state="$(capture PAUSED gcloud scheduler jobs describe "$job" --project="$project_id" \
    --location="$region" --format='value(state)')" && [[ "$state" == PAUSED ]] ||
    fail "the proof-tick job could not be re-paused; teardown must remove ${job}"
}

# RunJob requires ENABLED. Keep the job enabled until its worker receives
# the request, then restore PAUSED before the next proof phase.
run_proof_schedule() (
  local job="$1" start
  trap 'restore_paused_proof_schedule "$job"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  run gcloud scheduler jobs resume "$job" --project="$project_id" \
    --location="$region" --format=none || fail "the proof-tick job could not be resumed"
  start="$(capture 2026-01-01T00:00:00Z date -u +%Y-%m-%dT%H:%M:%SZ)"
  run gcloud scheduler jobs run "$job" --project="$project_id" \
    --location="$region" --format=none || fail "the proof-tick job could not be forced"
  wait_for_log "scheduler worker receipt" \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${scheduler_worker_service}\" AND jsonPayload.event=\"probe.schedule\" AND jsonPayload.job=\"${proof_schedule_path##*/}\" AND timestamp>=\"${start}\""
)

# One Cloud Task on the run's own paid-fulfillment queue, the marker in its
# body, signed as the tasks invoker. The tasks worker must log its receipt
# by markerSha256 alone. Then force the run's Scheduler job once and wait
# for the scheduler worker's receipt.
phase_worker_probe() {
  load_proof_run_file
  [[ -n "${QUEUE_SUFFIX:-}" ]] || $dry_run || fail "no recorded queue suffix; foundation records it"
  local suffix="${QUEUE_SUFFIX:-r${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}}" url body_file start
  url="$(service_url "$tasks_worker_service")"
  load_marker
  body_file="$task_body_file"
  (umask 077 && jq -cn --arg marker "$marker" '{marker: $marker}' >"$body_file")
  # The queue itself must send every task to the paid-fulfillment route
  # as the tasks invoker: the task carries no identity of its own, so the
  # receipt proves the queue's configuration.
  local queue="${proof_queue}-${suffix}" queue_config
  queue_config="$(capture "{\"state\":\"RUNNING\",\"httpTarget\":{\"uriOverride\":{\"host\":\"${url#https://}\",\"pathOverride\":{\"path\":\"${proof_queue_path}\"},\"uriOverrideEnforceMode\":\"ALWAYS\"},\"oidcToken\":{\"serviceAccountEmail\":\"${tasks_invoker}\",\"audience\":\"${url}\"}}}" \
    gcloud tasks queues describe "$queue" --project="$project_id" --location="$region" --format=json)" ||
    fail "the proof queue ${queue} is unreadable"
  jq -e --arg host "${url#https://}" --arg path "$proof_queue_path" --arg invoker "$tasks_invoker" --arg audience "$url" \
    '.state == "RUNNING"
      and .httpTarget.uriOverride.host == $host
      and .httpTarget.uriOverride.pathOverride.path == $path
      and .httpTarget.uriOverride.uriOverrideEnforceMode == "ALWAYS"
      and .httpTarget.oidcToken.serviceAccountEmail == $invoker
      and .httpTarget.oidcToken.audience == $audience' >/dev/null 2>&1 <<<"$queue_config" ||
    fail "${queue} does not send every task to ${proof_queue_path} on the tasks worker as the tasks invoker"
  start="$(capture 2026-01-01T00:00:00Z date -u +%Y-%m-%dT%H:%M:%SZ)"
  run gcloud tasks create-http-task --queue="$queue" --project="$project_id" \
    --location="$region" --url="${url}${proof_queue_path}" --method=POST \
    --header=Content-Type:application/json --body-file="$body_file" \
    --format='value(name)' || fail "the proof task could not be enqueued"
  rm -f "$body_file"
  wait_for_log "tasks worker receipt" \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${tasks_worker_service}\" AND jsonPayload.event=\"probe.task\" AND jsonPayload.queue=\"${proof_queue_path##*/}\" AND jsonPayload.markerSha256=\"$(marker_sha256)\" AND timestamp>=\"${start}\""

  # The run's own paused job, aimed at the scheduler worker as its invoker.
  local job="${proof_schedule_job}-${suffix}" described
  described="$(capture "{\"state\":\"PAUSED\",\"schedule\":\"0 0 1 1 *\",\"timeZone\":\"Etc/UTC\",\"userUpdateTime\":\"2026-11-26T11:30:00Z\",\"httpTarget\":{\"uri\":\"$(service_url "$scheduler_worker_service")${proof_schedule_path}\",\"httpMethod\":\"GET\",\"oidcToken\":{\"serviceAccountEmail\":\"${scheduler_invoker}\",\"audience\":\"$(service_url "$scheduler_worker_service")\"}}}" \
    gcloud scheduler jobs describe "$job" --project="$project_id" --location="$region" --format=json)" ||
    fail "the proof-tick job ${job} is unreadable"
  jq -e --arg uri "$(service_url "$scheduler_worker_service")${proof_schedule_path}" \
    --arg invoker "$scheduler_invoker" --arg audience "$(service_url "$scheduler_worker_service")" \
    '.state == "PAUSED" and .httpTarget.uri == $uri
      and .httpTarget.httpMethod == "GET" and .httpTarget.oidcToken.serviceAccountEmail == $invoker
      and .httpTarget.oidcToken.audience == $audience' \
    >/dev/null 2>&1 <<<"$described" ||
    fail "${job} is not a paused GET of ${proof_schedule_path} signed as the scheduler invoker"
  check_proof_schedule_window "$described" "$job"
  run_proof_schedule "$job"
}

phase_deliver_v2() {
  load_env_file "$digests_file"
  release deliver --sha "$GITHUB_SHA" --image-digest "${PROBE_V2_DIGEST:-}"
  local status
  status="$(release_status after-v2)"
  expect_settled "$status" "${PROBE_V2_DIGEST:-}"
  record_value "$releases_file" V2_RELEASE_ID "$(json_require '.record.active.releaseId' "$status")"
  expect_released v2
}

repository_description() {
  capture "$declared_repository_description" gcloud artifacts repositories describe \
    "$artifact_repository" --project="$project_id" --location="$region" \
    --format='value(description)'
}

# Out-of-band change to a safe declared field, detected by readback and
# Alchemy drift, repaired under the writer lock, then a no-op plan.
phase_drift() {
  local injected="sandbox proof drift ${GITHUB_RUN_ID}"
  run gcloud artifacts repositories update "$artifact_repository" \
    --project="$project_id" --location="$region" --description="$injected"
  expect_equal "drifted description" "$(repository_description)" "$injected"
  # The Alchemy drift check exits 2 for unrepaired drift, 0 for a clean stage and
  # 1 when the check itself failed (bad arguments, auth, a provider read).
  local code=0
  locked_stack drift || code=$?
  $dry_run && code=2
  case "$code" in
    2) ;;
    0) fail "Alchemy reported no drift after the injected description change" ;;
    *) fail "the Alchemy drift check failed (exit ${code})" ;;
  esac
  locked_stack repair
  expect_equal "repaired description" "$(repository_description)" "$declared_repository_description"
  release deploy
  expect_no_op_plan
}

# The persisted Cloud Run generation of every release service.
# Each release service's persisted Cloud Run generation, one per line in
# release_services order; fails when any read fails or is not a number.
release_service_generations() {
  local service generation
  for service in "${release_services[@]}"; do
    generation="$(capture 1 gcloud run services describe "$service" --project="$project_id" \
      --region="$region" --format='value(metadata.generation)' 2>/dev/null)" || return 1
    [[ "$generation" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$generation"
  done
}

# Whether some service's generation rose between two successful reads.
generations_increased() {
  local -a before after
  local index
  mapfile -t before <<<"$1"
  mapfile -t after <<<"$2"
  ((${#before[@]} == ${#release_services[@]} && ${#after[@]} == ${#release_services[@]})) || return 1
  for index in "${!release_services[@]}"; do
    ((after[index] > before[index])) && return 0
  done
  return 1
}

# Processes whose environment carries the interrupt token. Every descendant
# of the interrupted deliver inherits it, including the Alchemy child Bun's
# spawner moves into its own session and any process reparented after its
# parent died. A reaped or zombie process has no environment and drops out.
token_processes() {
  local token="$1" environ pid
  for environ in /proc/[0-9]*/environ; do
    pid="${environ#/proc/}"
    pid="${pid%/environ}"
    if grep -qzx "SANDBOX_PROOF_INTERRUPT_TOKEN=${token}" "$environ" 2>/dev/null; then
      printf '%s\n' "$pid"
    fi
  done
  return 0
}

# The writer-lock fingerprint of a token process's release writer: the
# lock holder is the first 12 hex digits of the SHA-256 of the writer token
# the deliver hands its Alchemy apply. The token itself is never printed.
token_writer_fingerprint() {
  local token="$1" pid writer
  while IFS= read -r pid; do
    writer="$(tr '\0' '\n' <"/proc/${pid}/environ" 2>/dev/null |
      sed -n 's/^WORKSPACE_RELEASE_WRITER=//p' | head -n 1)"
    if [[ -n "$writer" ]]; then
      printf '%s' "$writer" | sha256sum | cut -c1-12
      return 0
    fi
  done < <(token_processes "$token")
  return 1
}

# Stop, then kill, every token process until none remain; stopping first
# keeps one from forking a replacement. Fails if any survive.
kill_token_processes() {
  local token="$1" pids
  for _ in $(seq 1 50); do
    mapfile -t pids < <(token_processes "$token")
    ((${#pids[@]} == 0)) && return 0
    kill -STOP "${pids[@]}" 2>/dev/null || true
    kill -KILL "${pids[@]}" 2>/dev/null || true
    sleep 0.2
  done
  mapfile -t pids < <(token_processes "$token")
  ((${#pids[@]} == 0))
}

# Kill an in-flight `release deliver` once its Alchemy apply has persisted a
# Cloud Run change, with every process it started, then recover: once the
# Alchemy lease is quiet the confirmed-dead holder is cleared with
# `release unlock --holder` (the writer lock has no expiry), any pending
# traffic change is settled by `release recover`, and the deliver is rerun.
phase_interrupt_recover() {
  load_env_file "$digests_file"
  expect_settled "$(release_status before-interrupt)"
  local before after log="${proof_dir}/interrupted-deliver.log"
  before="$(release_service_generations)" ||
    fail "Cloud Run service generations are unreadable; the interrupt has no baseline"
  use_stack_config
  trace env "SANDBOX_PROOF_INTERRUPT_TOKEN=<random>" bun run release deliver \
    --sha "$GITHUB_SHA" --image-digest "${PROBE_V3_DIGEST:-}" "&"
  if ! $dry_run; then
    local token pid changed=false running fingerprint="" deadline=$((SECONDS + 900))
    token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
    (cd "$package_dir" && exec env "SANDBOX_PROOF_INTERRUPT_TOKEN=${token}" bun release.run.ts \
      deliver --sha "$GITHUB_SHA" --image-digest "$PROBE_V3_DIGEST") >"$log" 2>&1 &
    pid=$!
    # The token is in place once `env` has executed; a deliver that has
    # already ended never shows it.
    for _ in $(seq 1 100); do
      [[ -n "$(token_processes "$token")" ]] && break
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    # `kill -0` would still see an exited, unreaped deliver; the token does not.
    while ((SECONDS < deadline)) && [[ -n "$(token_processes "$token")" ]]; do
      # The deliver's own lock, read from its apply while it still runs.
      [[ -n "$fingerprint" ]] || fingerprint="$(token_writer_fingerprint "$token")" || true
      # A failed read is inconclusive: only a read generation increase counts.
      if after="$(release_service_generations)" && generations_increased "$before" "$after"; then
        changed=true
        break
      fi
      sleep 1
    done
    [[ -n "$fingerprint" ]] || fingerprint="$(token_writer_fingerprint "$token")" || true
    running="$(token_processes "$token")"
    kill_token_processes "$token" ||
      fail "processes of the interrupted deliver survived SIGKILL: $(token_processes "$token" | tr '\n' ' ')"
    wait "$pid" 2>/dev/null || true
    $changed || fail "the deliver persisted no Cloud Run change before it ended; nothing was interrupted"
    [[ -n "$running" ]] || fail "the deliver had exited when its change was seen; nothing was interrupted"
    [[ "$fingerprint" =~ ^[0-9a-f]{12}$ ]] ||
      fail "the interrupted deliver's writer lock was never identified; its lock stays for an operator"
    echo "killed the deliver after a persisted Cloud Run change; all its processes have exited"
  fi
  # A live Alchemy holder refreshes its lease; a quiet one has expired.
  wait_for_quiet_lease
  local status holder
  status="$(release_status interrupted)"
  holder="$(json_get '.record.writer.holder' "$status")"
  [[ -n "$holder" && "$holder" != null ]] || fail "the interrupted deliver left no writer lock"
  # Only the killed deliver's own lock is proven dead; another writer may
  # have taken the lock since, and teardown may clear no other.
  if ! $dry_run; then
    [[ "$holder" == "$fingerprint" ]] ||
      fail "the writer lock is held by ${holder}, not the killed deliver (${fingerprint}); it stays for an operator"
    printf '%s\n' "$holder" >"$dead_holder_file"
  fi
  local unlocked=false
  for _ in $(seq 1 20); do
    if release unlock --holder "$holder"; then
      unlocked=true
      break
    fi
    $dry_run && break
    sleep 15
  done
  $dry_run || $unlocked || fail "the stale writer lock could not be cleared"
  status="$(release_status unlocked)"
  if [[ "$(json_get '.record.pendingApply' "$status")" != null ]]; then
    release recover
    status="$(release_status recovered)"
  fi
  if [[ "$(json_get '.record.active.imageDigest' "$status")" != "${PROBE_V3_DIGEST:-}" ]]; then
    release deliver --sha "$GITHUB_SHA" --image-digest "${PROBE_V3_DIGEST:-}"
  fi
  status="$(release_status after-recovery)"
  expect_settled "$status" "${PROBE_V3_DIGEST:-}"
  expect_no_op_plan
  expect_released v3
}

# One live generation and CRC32C per Alchemy state object of the stack,
# lease excluded, sorted by name. A listing may also return noncurrent
# generations, so it only supplies names; each object is then described,
# which reads its live generation alone.
live_state_manifest() {
  local out="$1" names name described count
  names="$(gcloud storage objects list "gs://${state_bucket}/${stack_prefix}**" --format='value(name)')" ||
    fail "the stack's state objects are unreadable"
  : >"${out}.rows"
  count=0
  while IFS= read -r name; do
    [[ -z "$name" || "$name" == "$lease_object" ]] && continue
    # Only a name the service confirms has no live object is skipped
    # (noncurrent history); any other unreadable object fails the manifest
    # before a snapshot is accepted or a restore writes anything.
    described="$(storage_object "$name" name,generation,crc32c)" ||
      fail "state object ${name} is unreadable"
    [[ "$described" == absent ]] && continue
    jq -c --arg name "$name" \
      'select(.name == $name and (.generation | tostring | test("^[0-9]+$")) and (.crc32c // "") != "")
        | {name, generation: (.generation | tostring), crc32c}' \
      <<<"$described" >>"${out}.rows"
    count=$((count + 1))
  done < <(sort -u <<<"$names")
  jq -s 'sort_by(.name)' "${out}.rows" >"$out"
  rm -f "${out}.rows"
  [[ "$(jq 'length' "$out")" == "$count" ]] ||
    fail "a state object described without its own name, generation or CRC32C"
}

# Internal phases the writer-lock holder runs (sandbox-locked-stack.ts
# state-snapshot | state-restore); never called directly.
require_writer_lock() {
  [[ -n "${WORKSPACE_RELEASE_WRITER:-}" ]] || fail "$1 runs only under the writer lock"
}

phase_state_snapshot_locked() {
  require_writer_lock state-snapshot-locked
  live_state_manifest "${proof_dir}/state-live.json"
}

# Copy each snapshot generation back where the live one differs and remove
# objects the snapshot lacks, each guarded by the live generation just read,
# then require the live objects to match the snapshot's names and CRC32C.
phase_state_restore_locked() {
  require_writer_lock state-restore-locked
  local snapshot="${proof_dir}/state-snapshot.json" current="${proof_dir}/state-before-restore.json"
  [[ -s "$snapshot" ]] || fail "no state snapshot to restore"
  live_state_manifest "$current"
  local name wanted live
  while IFS=$'\t' read -r name wanted; do
    live="$(jq -r --arg name "$name" '.[] | select(.name == $name) | .generation' "$current")"
    [[ "$live" == "$wanted" ]] && continue
    run gcloud storage cp "gs://${state_bucket}/${name}#${wanted}" "gs://${state_bucket}/${name}" \
      --if-generation-match="${live:-0}"
  done < <(jq -r '.[] | [.name, .generation] | @tsv' "$snapshot")
  while IFS=$'\t' read -r name live; do
    run gcloud storage rm "gs://${state_bucket}/${name}" --if-generation-match="$live"
  done < <(jq -r --slurpfile snapshot "$snapshot" \
    '($snapshot[0] | map(.name)) as $kept | .[] | select(.name as $n | $kept | index($n) | not) | [.name, .generation] | @tsv' \
    "$current")
  live_state_manifest "${proof_dir}/state-restored.json"
  jq -e --slurpfile snapshot "$snapshot" \
    'map({name, crc32c}) == ($snapshot[0] | map({name, crc32c}))' \
    "${proof_dir}/state-restored.json" >/dev/null ||
    fail "the live state objects do not match the snapshot"
  echo "live Alchemy state matches the snapshot object for object"
}

# The live state manifest, read under the writer lock, into a named file.
locked_state_manifest() {
  locked_stack state-snapshot
  $dry_run || cp "${proof_dir}/state-live.json" "${proof_dir}/$1"
}

# Snapshot the stack's live Alchemy state, make a tracked change (restore
# traffic to v2), restore the snapshot and reconcile. Snapshot and restore
# each hold the writer lock, after the Alchemy lease has gone quiet.
phase_state_snapshot_restore() {
  load_env_file "$releases_file"
  expect_settled "$(release_status before-snapshot)"
  wait_for_quiet_lease
  locked_state_manifest state-snapshot.json

  local status generation
  status="$(release_status before-tracked-change)"
  generation="$(json_require '.record.generation' "$status")"
  release restore --release-id "${V2_RELEASE_ID:-}" --expected-generation "$generation"
  expect_released v2

  expect_settled "$(release_status after-tracked-change)"
  wait_for_quiet_lease
  locked_state_manifest state-changed.json
  if ! $dry_run; then
    jq -e --slurpfile before "${proof_dir}/state-snapshot.json" '. != $before[0]' \
      "${proof_dir}/state-changed.json" >/dev/null ||
      fail "the tracked change wrote no Alchemy state object"
  fi

  locked_stack state-restore
  echo "Alchemy state restored to the snapshot"

  release deploy
  expect_no_op_plan
  expect_settled "$(release_status after-state-restore)"
  expect_released v2
}

phase_restore_v1() {
  load_env_file "$releases_file"
  load_env_file "$digests_file"
  local status generation
  status="$(release_status before-restore)"
  generation="$(json_require '.record.generation' "$status")"
  release restore --release-id "${V1_RELEASE_ID:-}" --expected-generation "$generation"
  expect_settled "$(release_status after-restore)" "${PROBE_V1_DIGEST:-}"
  expect_released v1
  # The data path too, with an ID token minted for this step.
  run_rpc_probe v1 restore
}

# The run's marker travelled only in RPC and task bodies; it must reach no
# searchable log and no readable trace. Each source needs a positive
# control first: Cloud Logging must hold the probe's POST /rpc request log
# under its trace, and Cloud Trace the probe's trace. A control that is
# absent or unreadable fails the proof rather than counting as clean.
phase_telemetry_privacy() {
  load_marker
  load_env_file "$telemetry_file"
  local trace_id="${PROBE_TRACE_ID:-}"
  if $dry_run; then
    trace_id="${trace_id:-0123456789abcdef0123456789abcdef}"
  fi
  [[ "$trace_id" =~ ^[0-9a-f]{32}$ ]] || fail "no recorded probe trace ID; the rpc-probe phase records it"
  pause 90
  # Log reads reach back past the primary probe, at least two hours.
  local freshness=7200
  if [[ "${PROBE_STARTED_AT:-}" =~ ^[0-9]+$ ]] && (($(date -u +%s) - PROBE_STARTED_AT + 900 > freshness)); then
    freshness=$(($(date -u +%s) - PROBE_STARTED_AT + 900))
  fi

  local requests="" control=false
  for _ in $(seq 1 8); do
    requests="$(capture "[{\"trace\":\"projects/${project_id}/traces/${trace_id}\",\"httpRequest\":{\"requestUrl\":\"https://${api_service}.run.app/rpc\"}}]" \
      gcloud logging read \
      "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${api_service}\" AND log_id(\"run.googleapis.com/requests\") AND httpRequest.requestMethod=\"POST\" AND trace=\"projects/${project_id}/traces/${trace_id}\"" \
      --project="$project_id" --freshness="${freshness}s" --limit=5 --format='json(trace,httpRequest.requestUrl)')" ||
      fail "Cloud Run request logs are unreadable; marker absence unverified"
    # Effect's HTTP RPC protocol joins prependUrl(rpcUrl) with "", producing /rpc/.
    if jq -e --arg id "$trace_id" 'type == "array" and any(.[];
        ((.trace // "") | endswith("/traces/" + $id))
        and ((.httpRequest.requestUrl // "") | test("^https?://[^/?#]+/rpc/?([?#].*)?$")))' \
      >/dev/null 2>&1 <<<"$requests"; then
      control=true
      break
    fi
    $dry_run && break
    pause 15
  done
  $control || fail "no POST /rpc request log carries the probe trace ${trace_id}; marker absence would prove nothing"
  echo "Cloud Logging holds the probe's POST /rpc request log"

  # A bare quoted global restriction applies substring matching across every
  # log field and payload; Cloud Logging rejects nested message fields such as
  # jsonPayload:"..." with INVALID_ARGUMENT.
  local logs
  logs="$(capture '[]' gcloud logging read \
    "\"${marker}\"" \
    --project="$project_id" --freshness="${freshness}s" --limit=20 --format='json(logName,timestamp)')" ||
    fail "Cloud Logging is unreadable; marker absence in logs unverified"
  jq -e 'type == "array" and length == 0' >/dev/null 2>&1 <<<"$logs" ||
    fail "the marker reached readable logs: $(jq -c '[.[]? | .logName]' <<<"$logs" 2>/dev/null)"
  echo "marker absent from every searchable Cloud Logging entry"

  local trace_body="" spans=0
  for _ in $(seq 1 12); do
    if trace_body="$(google_get "{\"traceId\":\"${trace_id}\",\"spans\":[{\"name\":\"/rpc\"}]}" \
      "https://cloudtrace.googleapis.com/v1/projects/${project_id}/traces/${trace_id}")"; then
      spans="$(jq '[.spans[]?] | length' <<<"$trace_body" 2>/dev/null || echo 0)"
      ((spans > 0)) && break
    fi
    $dry_run && break
    pause 15
  done
  ((spans > 0)) ||
    fail "trace control unavailable: Cloud Trace holds no span of the probe trace ${trace_id} (denied, empty or not ingested); marker absence in traces would prove nothing"
  [[ "$trace_body" != *"$marker"* ]] || fail "the marker reached the probe's trace"
  echo "Cloud Trace holds the probe trace ${trace_id}"

  # Every trace since the earlier of the primary probe and an hour ago,
  # spans with names and labels, which must include the probe's own.
  local window traces page="" listed=false start_epoch
  start_epoch=$(($(date -u +%s) - 3600))
  if [[ "${PROBE_STARTED_AT:-}" =~ ^[0-9]+$ ]] && ((PROBE_STARTED_AT - 300 < start_epoch)); then
    start_epoch=$((PROBE_STARTED_AT - 300))
  fi
  window="$(capture 2026-01-01T00:00:00Z date -u -d "@${start_epoch}" +%Y-%m-%dT%H:%M:%SZ)"
  for _ in $(seq 1 20); do
    traces="$(google_get "{\"traces\":[{\"traceId\":\"${trace_id}\"}]}" \
      "https://cloudtrace.googleapis.com/v1/projects/${project_id}/traces?view=COMPLETE&pageSize=100&startTime=${window}${page:+&pageToken=${page}}")" ||
      fail "Cloud Trace is unreadable; marker absence in traces unverified"
    [[ "$traces" != *"$marker"* ]] || fail "the marker reached a Cloud Trace span"
    jq -e --arg id "$trace_id" 'any(.traces[]?; .traceId == $id)' >/dev/null 2>&1 <<<"$traces" &&
      listed=true
    # A raw `+`, `/` or `=` in a page token would reach Cloud Trace altered.
    page="$(jq -r '.nextPageToken // empty | @uri' <<<"$traces")"
    [[ -z "$page" ]] && break
  done
  [[ -z "$page" ]] || fail "more than 20 pages of traces; marker absence unverified"
  $listed || fail "the trace listing omits the probe's trace; marker absence unverified"
  echo "marker absent from every Cloud Trace span of the last hour"
}

# Scoped destroy of exactly the sandbox stack under the writer lock. The
# state bucket, the GitHub and Vercel WIF and the deployer stay; the release record's
# live object and the proof run record are removed so the next proof starts
# empty, and their generations stay as noncurrent history in the versioned
# bucket. A refused lock or a failed destroy stops here: nothing is ever
# deleted outside the lock, and the stack state is left for an operator.
phase_stack_destroy() {
  local status="" holder=""
  # The locked destroy takes the writer lock itself and refuses a held one,
  # so an unreadable status only skips clearing a proven-dead holder; it
  # never stops the teardown.
  if status="$(release_status before-destroy)"; then
    holder="$(json_get '.record.writer.holder' "$status")"
  else
    warning "the release status is unreadable; the locked destroy decides on the writer lock"
    status=""
  fi
  if ! $dry_run && [[ -n "$holder" && "$holder" != null ]]; then
    # Only the holder whose whole process tree the interrupt phase proved
    # dead may be cleared, and only once the Alchemy lease is quiet; any
    # other holder may still be writing, so its lock stays for an operator.
    [[ -f "$dead_holder_file" && "$(cat "$dead_holder_file")" == "$holder" ]] ||
      fail "the writer lock is held by ${holder}, whose death this run did not establish; the lock stays and nothing was destroyed (an operator must confirm it stopped)"
    wait_for_quiet_lease
    release unlock --holder "$holder" ||
      fail "the writer lock held by ${holder} was not released; nothing was destroyed"
    status="$(release_status destroy-unlocked)"
  fi
  if ! $dry_run && [[ -n "$status" && "$(json_get '.record.pendingApply' "$status")" != null ]]; then
    release recover || warning "recover failed; destroy may refuse the pending apply"
  fi
  locked_stack destroy ||
    fail "the locked Alchemy destroy failed or its lock was refused; nothing was deleted outside the lock, and the stack state under ${stack_prefix} needs an operator (rerun cleanup-only)"
  run gcloud storage rm "gs://${state_bucket}/${record_object}" ||
    warning "the release record's live object could not be removed"
  run gcloud storage rm "gs://${state_bucket}/${proof_run_object}" ||
    warning "the proof run record could not be removed"
}

phase_post_destroy_inventory() {
  take_inventory post-destroy
  local dir="${proof_dir}/inventory-post-destroy" file class pattern residual=false unverified=()
  if ! $dry_run; then
    for file in "$dir"/*.txt; do
      class="$(basename "$file" .txt)"
      if [[ "$(cat "$file")" == UNVERIFIED ]]; then
        unverified+=("$class")
        continue
      fi
      pattern="$(proof_pattern "$class")"
      if proof_residuals "$class" "$pattern" "$file" >"${dir}/${class}.residual"; then
        residual=true
        echo "::error::proof resources remain in ${class}: $(tr '\n' ' ' <"${dir}/${class}.residual")"
      else
        rm -f "${dir}/${class}.residual"
      fi
    done
  fi
  billing projects describe "$project_id" --format='value(billingEnabled,billingAccountName)' ||
    notice "billing link unverified (denied)"
  rm -f "$marker_file"
  ! $residual || fail "proof resources remain after teardown"
  # Every class is required: an unreadable one could hide residue. Each
  # listing's error stays in its .err file.
  ((${#unverified[@]} == 0)) ||
    fail "teardown unverified: ${unverified[*]} could not be listed (see each class's .err file)"
  echo "no proof resources remain in any class"
}

# ---------------------------------------------------------------- dispatch

run_phase() {
  local name="$1"
  phase "$name"
  case "$name" in
    # Inventories list with gcloud alone, so a token problem never hides
    # what a failed teardown left behind.
    guard | readonly-inventory | baseline-inventory | post-destroy-inventory | state-snapshot-locked | state-restore-locked) ;;
    # Refreshed in this shell, never inside a command substitution, so
    # the mask applies and every later command sees the token.
    *) ensure_alchemy_token ;;
  esac
  case "$name" in
    guard) phase_guard ;;
    preflight) phase_preflight ;;
    readonly-inventory) phase_readonly_inventory ;;
    baseline-inventory) phase_baseline_inventory ;;
    foundation) phase_foundation ;;
    images) phase_images ;;
    deliver-v1) phase_deliver_v1 ;;
    private-access) phase_private_access ;;
    rpc-probe) phase_rpc_probe ;;
    worker-probe) phase_worker_probe ;;
    deliver-v2) phase_deliver_v2 ;;
    drift) phase_drift ;;
    interrupt-recover) phase_interrupt_recover ;;
    state-snapshot-restore) phase_state_snapshot_restore ;;
    state-snapshot-locked) phase_state_snapshot_locked ;;
    state-restore-locked) phase_state_restore_locked ;;
    restore-v1) phase_restore_v1 ;;
    telemetry-privacy) phase_telemetry_privacy ;;
    stack-destroy) phase_stack_destroy ;;
    post-destroy-inventory) phase_post_destroy_inventory ;;
    *) usage ;;
  esac
}

for argument in "$@"; do
  case "$argument" in
    hosted-proof) for p in "${hosted_proof_phases[@]}"; do run_phase "$p"; done ;;
    cleanup-only) for p in "${cleanup_phases[@]}"; do run_phase "$p"; done ;;
    *) run_phase "$argument" ;;
  esac
done
