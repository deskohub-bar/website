#!/usr/bin/env bash
# Owner-operated bootstrap for the Workspace Google Cloud sandbox (#1452).
#
# Run it in an authorized Cloud Shell for the sandbox project. It enables
# the APIs the first deployment needs, records approved spend and teardown
# on the project, creates the deploy, runtime, invoker and frontend service
# accounts, trusts GitHub Actions only for the protected sandbox environment
# of the trusted workflow, trusts Vercel only for the project's preview
# deployments, creates the versioned state bucket, and prints the
# `gh variable set` commands for the repository maintainer and the Vercel
# Preview identifiers. It never reads, writes or prints a secret value.
# Rerunning it is safe and converges.
#
# It runs in two phases. The first grants the deploy identity only the
# read access the smoke workflow needs. After the smoke workflow passes and
# a run outside the trusted workflow or environment is confirmed denied,
# rerun with --grant-deploy-roles to grant deployment permissions.
#
# Once the hosted proof of the IAM-private stack passes, rerun with
# --revoke-retired-edge-roles as well. It removes the load balancer and Cloud
# Armor admin roles earlier versions granted the deployer, then verifies that
# the deployer retains log and trace access and the scheduler alert's Logging role.
#
# Usage:
#   bootstrap-sandbox-wif.sh \
#     --project-id <id> --github-repository <owner>/<name> \
#     --github-owner-id <numeric id> --github-repository-id <numeric id> \
#     --max-spend <amount> --currency <ISO 4217> --teardown-date <YYYY-MM-DD> \
#     --vercel-team-slug <slug> --vercel-project <name> \
#     --vercel-owner-id <team_…> --vercel-project-id <prj_…> \
#     [--region europe-west1] [--project-number <number>] \
#     [--grant-deploy-roles] [--revoke-retired-edge-roles] \
#     [--managed-secret <secret id>]... [--dry-run]
#
# Numeric GitHub IDs: gh api repos/<owner>/<name> --jq '.owner.id, .id'
# Vercel IDs: the project's settings or `vercel project inspect`; the
# project must use OIDC Federation in Team issuer mode.
# --dry-run prints every command instead of running it.
set -euo pipefail

region="europe-west1"
environment_name="workspace-gcp-sandbox"
trusted_workflow_path=".github/workflows/workspace-gcp-sandbox-smoke.yml"
trusted_ref="refs/heads/main"
# A pool dedicated to this one provider, so no other provider can map to
# the same subject.
pool_id="workspace-sandbox-github"
provider_id="deskohub-workspace"
# Vercel's OIDC pool, likewise holding only its own provider.
vercel_pool_id="workspace-vercel"
vercel_provider_id="vercel"
dry_run=false
grant_deploy_roles=false
revoke_retired_edge_roles=false
managed_secrets=()
project_id=""
project_number=""
github_repository=""
github_owner_id=""
github_repository_id=""
max_spend=""
currency=""
teardown_date=""
vercel_team_slug=""
vercel_project=""
vercel_owner_id=""
vercel_project_id=""

usage() {
  sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

fail() {
  echo "bootstrap-sandbox-wif: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id) project_id="${2:-}"; shift 2 ;;
    --project-number) project_number="${2:-}"; shift 2 ;;
    --region) region="${2:-}"; shift 2 ;;
    --github-repository) github_repository="${2:-}"; shift 2 ;;
    --github-owner-id) github_owner_id="${2:-}"; shift 2 ;;
    --github-repository-id) github_repository_id="${2:-}"; shift 2 ;;
    --max-spend) max_spend="${2:-}"; shift 2 ;;
    --currency) currency="${2:-}"; shift 2 ;;
    --teardown-date) teardown_date="${2:-}"; shift 2 ;;
    --vercel-team-slug) vercel_team_slug="${2:-}"; shift 2 ;;
    --vercel-project) vercel_project="${2:-}"; shift 2 ;;
    --vercel-owner-id) vercel_owner_id="${2:-}"; shift 2 ;;
    --vercel-project-id) vercel_project_id="${2:-}"; shift 2 ;;
    --grant-deploy-roles) grant_deploy_roles=true; shift ;;
    --revoke-retired-edge-roles) revoke_retired_edge_roles=true; shift ;;
    --managed-secret) managed_secrets+=("${2:-}"); shift 2 ;;
    --dry-run) dry_run=true; shift ;;
    -h | --help) usage ;;
    *) fail "unknown argument: $1" ;;
  esac
done

validate_inputs() {
  # Revocation reads back a policy the deploy-roles phase converges first.
  [[ "$revoke_retired_edge_roles" == false || "$grant_deploy_roles" == true ]] ||
    fail "--revoke-retired-edge-roles needs --grant-deploy-roles"
  # Byte-wise: in a UTF-8 locale, ranges such as [a-z] admit accented
  # letters and ${#…} counts characters, not bytes.
  local LC_ALL=C
  [[ "$project_id" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "--project-id must be a Google Cloud project ID"
  [[ "$region" =~ ^[a-z]+-[a-z]+[0-9]$ ]] || fail "--region must be a Google Cloud region"
  [[ "$github_repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "--github-repository must be <owner>/<name>"
  [[ "$github_owner_id" =~ ^[1-9][0-9]*$ ]] || fail "--github-owner-id must be the numeric owner ID"
  [[ "$github_repository_id" =~ ^[1-9][0-9]*$ ]] || fail "--github-repository-id must be the numeric repository ID"
  [[ "$max_spend" =~ ^[1-9][0-9]*$ ]] || fail "--max-spend must be a whole amount"
  [[ "$currency" =~ ^[A-Z]{3}$ ]] || fail "--currency must be an ISO 4217 code"
  [[ "$teardown_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "--teardown-date must be YYYY-MM-DD"
  # The Vercel values land in the provider's CEL condition and the trusted
  # subject, so they admit no quote, colon or space.
  [[ "$vercel_team_slug" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || fail "--vercel-team-slug must be the Vercel team slug"
  [[ "$vercel_project" =~ ^[a-z0-9._-]{1,100}$ ]] || fail "--vercel-project must be the Vercel project name"
  [[ "$vercel_owner_id" =~ ^team_[A-Za-z0-9]+$ ]] || fail "--vercel-owner-id must be the Vercel team ID"
  [[ "$vercel_project_id" =~ ^prj_[A-Za-z0-9]+$ ]] || fail "--vercel-project-id must be the Vercel project ID"
  # google.subject maps to at most 127 bytes; the C locale counts bytes.
  vercel_subject="owner:${vercel_team_slug}:project:${vercel_project}:environment:preview"
  ((${#vercel_subject} <= 127)) ||
    fail "--vercel-team-slug and --vercel-project make a preview subject longer than Google's 127 bytes"
  for secret_id in "${managed_secrets[@]}"; do
    [[ "$secret_id" =~ ^[A-Za-z0-9_-]{1,255}$ ]] || fail "--managed-secret must be a Secret Manager secret ID"
  done
  if [[ -n "$project_number" && ! "$project_number" =~ ^[1-9][0-9]{5,19}$ ]]; then
    fail "--project-number must be numeric"
  fi
}
validate_inputs

print_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run() {
  print_command "$@"
  if [[ "$dry_run" == false ]]; then
    "$@"
  fi
}

# True when the described resource already exists. Dry runs assume it
# does not, so they print every create.
exists() {
  [[ "$dry_run" == false ]] && "$@" >/dev/null 2>&1
}

# Live runs always resolve the number from the approved project ID, before
# any change, so a mistyped --project-number never grants another
# project's service agents access here.
if [[ "$dry_run" == false ]]; then
  resolved_number="$(gcloud projects describe "$project_id" --format='value(projectNumber)')"
  [[ "$resolved_number" =~ ^[1-9][0-9]{5,19}$ ]] || fail "could not resolve the number of $project_id"
  if [[ -n "$project_number" && "$project_number" != "$resolved_number" ]]; then
    fail "--project-number does not belong to $project_id"
  fi
  project_number="$resolved_number"
elif [[ -z "$project_number" ]]; then
  project_number="000000000000"
fi

if [[ "$dry_run" == false ]]; then
  # Billing reads charge quota to the sandbox, not the caller's default project.
  billing_enabled="$(CLOUDSDK_BILLING_QUOTA_PROJECT="$project_id" \
    gcloud billing projects describe "$project_id" --format='value(billingEnabled)')"
  [[ "$billing_enabled" == "True" ]] || fail "billing is not enabled on $project_id; link the approved billing account first"
fi

sa_email() { echo "$1@${project_id}.iam.gserviceaccount.com"; }

# Like run, but retries Google's per-minute quota and rate refusals with
# backoff (service accounts: 5 creations a minute) and treats an already
# existing resource as success, so reruns and races converge.
run_with_quota_retry() {
  local attempt=1 max_attempts=6 delay=15 output
  print_command "$@"
  [[ "$dry_run" == false ]] || return 0
  while true; do
    if output="$("$@" 2>&1)"; then
      [[ -z "$output" ]] || printf '%s\n' "$output"
      return 0
    fi
    if grep -qiE 'already exists|ALREADY_EXISTS' <<<"$output"; then
      echo "already exists; continuing"
      return 0
    fi
    if ((attempt < max_attempts)) &&
      grep -qiE 'RESOURCE_EXHAUSTED|quota|rate limit|rateLimitExceeded|too many requests|\b429\b' <<<"$output"; then
      echo "quota or rate limit (attempt ${attempt}/${max_attempts}); retrying in ${delay}s" >&2
      sleep "$delay"
      attempt=$((attempt + 1))
      delay=$((delay * 2 > 60 ? 60 : delay * 2))
      continue
    fi
    printf '%s\n' "$output" >&2
    return 1
  done
}

# Like run, but treats an already absent binding as success, so revoking
# a grant an earlier version made converges on reruns and fresh projects.
run_revoke() {
  local output
  print_command "$@"
  [[ "$dry_run" == false ]] || return 0
  if output="$("$@" 2>&1)"; then
    return 0
  fi
  # Only gcloud's own missing-binding refusal proves the policy was read.
  if grep -qF 'Policy binding with the specified principal, role, and condition not found' <<<"$output"; then
    echo "already absent; continuing"
    return 0
  fi
  printf '%s\n' "$output" >&2
  return 1
}

# Sets the approved spend and teardown labels through Cloud Resource
# Manager v3, keeping every other label: `updateMask=labels` replaces the
# whole map, so live runs merge with the labels read first. The access
# token reaches curl on stdin, never argv or output.
update_project_labels() {
  local existing="" pair key body="" url response token
  local -A labels=()
  local -a pairs=()
  url="https://cloudresourcemanager.googleapis.com/v3/projects/${project_id}?updateMask=labels"
  if [[ "$dry_run" == false ]]; then
    # Checked: a failed read must stop here, never drop existing labels.
    existing="$(gcloud projects describe "$project_id" --format='value(labels)')" ||
      fail "could not read the labels of $project_id"
  fi
  IFS=';' read -ra pairs <<<"$existing"
  for pair in "${pairs[@]}"; do
    [[ -n "$pair" ]] || continue
    [[ "$pair" == *=* && "$pair" != *[\"\\]* ]] || fail "unexpected label on $project_id: $pair"
    labels["${pair%%=*}"]="${pair#*=}"
  done
  labels[workspace-sandbox-max-spend]="$spend_label"
  labels[workspace-sandbox-teardown]="$teardown_date"
  while IFS= read -r key; do
    body+="${body:+,}\"${key}\":\"${labels[$key]}\""
  done < <(printf '%s\n' "${!labels[@]}" | LC_ALL=C sort)
  body="{\"labels\":{${body}}}"
  [[ "$dry_run" == false ]] || echo "# live runs merge these labels with the project's existing labels"
  print_command curl -sS --fail-with-body -X PATCH "$url" \
    -H "Authorization: Bearer <gcloud auth print-access-token>" \
    -H "Content-Type: application/json" --data "$body"
  [[ "$dry_run" == false ]] || return 0
  token="$(gcloud auth print-access-token)" || fail "could not get an access token"
  response="$(curl -sS --fail-with-body -X PATCH "$url" -H @- \
    -H "Content-Type: application/json" --data "$body" <<<"Authorization: Bearer ${token}")" || {
    printf '%s\n' "$response" >&2
    fail "could not update the labels of $project_id"
  }
}
deployer="$(sa_email workspace-deployer)"
runtime_accounts=(workspace-api workspace-tasks-worker workspace-scheduler-worker)
invoker_accounts=(workspace-tasks-invoker workspace-scheduler-invoker)
publisher_account=workspace-mobile-publisher
frontend_account=workspace-frontend-preview
state_bucket="${project_id}-workspace-state"
pool_name="projects/${project_number}/locations/global/workloadIdentityPools/${pool_id}"
provider_name="${pool_name}/providers/${provider_id}"
trusted_workflow_ref="${github_repository}/${trusted_workflow_path}@${trusted_ref}"
trusted_subject="repo:${github_repository}:environment:${environment_name}"
vercel_pool_name="projects/${project_number}/locations/global/workloadIdentityPools/${vercel_pool_id}"
vercel_issuer="https://oidc.vercel.com/${vercel_team_slug}"

echo "== APIs"
run gcloud services enable --project "$project_id" \
  artifactregistry.googleapis.com cloudbilling.googleapis.com \
  cloudresourcemanager.googleapis.com cloudscheduler.googleapis.com \
  cloudtasks.googleapis.com cloudtrace.googleapis.com compute.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com logging.googleapis.com \
  monitoring.googleapis.com run.googleapis.com secretmanager.googleapis.com \
  storage.googleapis.com sts.googleapis.com telemetry.googleapis.com

echo "== Approved spend and teardown"
spend_label="$(echo "${max_spend}-${currency}" | tr '[:upper:]' '[:lower:]')"
update_project_labels

echo "== Service accounts"
for account in workspace-deployer "${runtime_accounts[@]}" "${invoker_accounts[@]}" \
  "$publisher_account" "$frontend_account"; do
  exists gcloud iam service-accounts describe "$(sa_email "$account")" --project "$project_id" ||
    run_with_quota_retry gcloud iam service-accounts create "$account" --project "$project_id" \
    --display-name "Workspace ${account#workspace-}"
done

echo "== Runtime accounts may enqueue Cloud Tasks as the tasks invoker"
for account in "${runtime_accounts[@]}"; do
  run gcloud projects add-iam-policy-binding "$project_id" --condition=None --quiet \
    --member "serviceAccount:$(sa_email "$account")" --role roles/cloudtasks.enqueuer --format=none
  run gcloud iam service-accounts add-iam-policy-binding "$(sa_email workspace-tasks-invoker)" \
    --project "$project_id" --member "serviceAccount:$(sa_email "$account")" \
    --role roles/iam.serviceAccountUser --format=none
done

echo "== Retired runtime trace-writer grants"
# No collector sidecar exports traces any more. Earlier versions granted
# these to the runtime accounts, including the retired workspace-web.
for account in workspace-web workspace-tasks-worker workspace-scheduler-worker; do
  for role in roles/telemetry.tracesWriter roles/cloudtrace.agent; do
    run_revoke gcloud projects remove-iam-policy-binding "$project_id" --condition=None --quiet \
      --member "serviceAccount:$(sa_email "$account")" --role "$role" --format=none
  done
done

echo "== Google service agents may act as and mint OIDC tokens for their invokers"
# Cloud Tasks and Cloud Scheduler sign each request as the invoker account.
# Their service agents need Service Account Token Creator on it, and Cloud
# Tasks' primary agent also needs Service Account User (actAs).
run gcloud beta services identity create --service cloudtasks.googleapis.com --project "$project_id" --format=none
run gcloud beta services identity create --service cloudscheduler.googleapis.com --project "$project_id" --format=none
run gcloud iam service-accounts add-iam-policy-binding "$(sa_email workspace-tasks-invoker)" \
  --project "$project_id" --role roles/iam.serviceAccountTokenCreator --format=none \
  --member "serviceAccount:service-${project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
run gcloud iam service-accounts add-iam-policy-binding "$(sa_email workspace-tasks-invoker)" \
  --project "$project_id" --role roles/iam.serviceAccountUser --format=none \
  --member "serviceAccount:service-${project_number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
run gcloud iam service-accounts add-iam-policy-binding "$(sa_email workspace-scheduler-invoker)" \
  --project "$project_id" --role roles/iam.serviceAccountTokenCreator --format=none \
  --member "serviceAccount:service-${project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"

# Creates the pool and its OIDC provider, then converges the provider's
# issuer, audiences, mapping and condition (the remaining arguments) on
# reruns.
ensure_oidc_provider() {
  local pool="$1" pool_display="$2" provider="$3" provider_display="$4"
  shift 4
  exists gcloud iam workload-identity-pools describe "$pool" --project "$project_id" --location global ||
    run gcloud iam workload-identity-pools create "$pool" --project "$project_id" --location global \
    --display-name "$pool_display"
  exists gcloud iam workload-identity-pools providers describe "$provider" \
    --project "$project_id" --location global --workload-identity-pool "$pool" ||
    run gcloud iam workload-identity-pools providers create-oidc "$provider" \
    --project "$project_id" --location global --workload-identity-pool "$pool" \
    --display-name "$provider_display" "$@"
  run gcloud iam workload-identity-pools providers update-oidc "$provider" \
    --project "$project_id" --location global --workload-identity-pool "$pool" "$@"
}

# Grant by subject only when the provider is its pool's sole provider and
# trusts only keys discovered from its issuer: uploaded signing keys would
# replace the issuer's published keys as the trust root.
require_trusted_provider() {
  local pool="$1" provider="$2" issuer="$3" providers issuer_uri jwks_json
  [[ "$dry_run" == false ]] || return 0
  provider_field() {
    gcloud iam workload-identity-pools providers describe "$provider" \
      --project "$project_id" --location global --workload-identity-pool "$pool" \
      --format="value($1)"
  }
  # Checked assignments: a failed read must stop here, never look empty.
  providers="$(gcloud iam workload-identity-pools providers list --project "$project_id" \
    --location global --workload-identity-pool "$pool" --format='value(name)')" ||
    fail "could not list the providers of pool $pool"
  [[ "$providers" == "projects/${project_number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}" ]] ||
    fail "pool $pool must contain only provider $provider before access is granted"
  issuer_uri="$(provider_field oidc.issuerUri)" ||
    fail "could not read the issuer of provider $provider"
  jwks_json="$(provider_field oidc.jwksJson)" ||
    fail "could not read the signing keys of provider $provider"
  [[ "$issuer_uri" == "$issuer" ]] ||
    fail "provider $provider must use the issuer $issuer"
  [[ -z "$jwks_json" ]] ||
    fail "provider $provider has uploaded signing keys; remove them so the issuer's published keys are the trust root"
}

echo "== Workload identity federation for GitHub Actions"
attribute_mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.environment=assertion.environment,attribute.workflow_ref=assertion.workflow_ref"
attribute_condition="assertion.repository_owner_id == '${github_owner_id}' && assertion.repository_id == '${github_repository_id}' && assertion.environment == '${environment_name}' && assertion.workflow_ref == '${trusted_workflow_ref}'"
ensure_oidc_provider "$pool_id" "GitHub Actions" "$provider_id" "Deskohub Workspace sandbox" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "$attribute_mapping" \
  --attribute-condition "$attribute_condition"
require_trusted_provider "$pool_id" "$provider_id" "https://token.actions.githubusercontent.com"
run gcloud iam service-accounts add-iam-policy-binding "$deployer" --project "$project_id" \
  --role roles/iam.workloadIdentityUser --format=none \
  --member "principal://iam.googleapis.com/${pool_name}/subject/${trusted_subject}"

echo "== Workload identity federation for Vercel preview deployments"
# Vercel's claims cannot tell preview branches apart, so every preview
# deployment of the project shares the frontend preview identity. The
# sandbox provider admits the preview environment only.
vercel_mapping="google.subject=assertion.sub,attribute.owner_id=assertion.owner_id,attribute.project_id=assertion.project_id,attribute.environment=assertion.environment"
vercel_condition="assertion.owner_id=='${vercel_owner_id}' && assertion.project_id=='${vercel_project_id}' && assertion.environment=='preview'"
ensure_oidc_provider "$vercel_pool_id" "Vercel OIDC" "$vercel_provider_id" "Vercel preview" \
  --issuer-uri "$vercel_issuer" \
  --allowed-audiences "https://vercel.com/${vercel_team_slug}" \
  --attribute-mapping "$vercel_mapping" \
  --attribute-condition "$vercel_condition"
require_trusted_provider "$vercel_pool_id" "$vercel_provider_id" "$vercel_issuer"
run gcloud iam service-accounts add-iam-policy-binding "$(sa_email "$frontend_account")" --project "$project_id" \
  --role roles/iam.workloadIdentityUser --format=none \
  --member "principal://iam.googleapis.com/${vercel_pool_name}/subject/${vercel_subject}"

echo "== Versioned state bucket"
exists gcloud storage buckets describe "gs://${state_bucket}" ||
  run gcloud storage buckets create "gs://${state_bucket}" --project "$project_id" \
  --location "$region" --uniform-bucket-level-access --public-access-prevention
# The bucket's location fixes the stage's region (verifyStackTarget); an
# existing bucket elsewhere would refuse every deploy.
if [[ "$dry_run" == false ]]; then
  bucket_location="$(gcloud storage buckets describe "gs://${state_bucket}" \
    --format='value(location,location_type)' | tr '[:upper:]' '[:lower:]')"
  [[ "$bucket_location" == "${region}"$'\t'"region" ]] ||
    fail "state bucket ${state_bucket} must be a single-region bucket in ${region}"
fi
run gcloud storage buckets update "gs://${state_bucket}" --versioning \
  --uniform-bucket-level-access --public-access-prevention

echo "== Smoke-check access for the deploy identity (read only)"
run gcloud projects add-iam-policy-binding "$project_id" --condition=None --quiet \
  --member "serviceAccount:${deployer}" --role roles/browser --format=none
run gcloud storage buckets add-iam-policy-binding "gs://${state_bucket}" \
  --member "serviceAccount:${deployer}" --role roles/storage.legacyBucketReader --format=none

if [[ "$grant_deploy_roles" == true ]]; then
  echo "== Deployer project roles"
  # Compute read access lets the hosted proof show the stack owns no load
  # balancer, network endpoint group, security policy or certificate.
  # The log-based SchedulerFailureAlert needs logging.notificationRules.create.
  for role in roles/run.admin roles/cloudtasks.admin roles/cloudscheduler.admin \
    roles/artifactregistry.admin roles/storage.admin roles/monitoring.alertPolicyEditor \
    roles/compute.viewer roles/logging.viewer roles/cloudtrace.user roles/logging.configWriter \
    roles/serviceusage.serviceUsageConsumer; do
    run gcloud projects add-iam-policy-binding "$project_id" --condition=None --quiet \
      --member "serviceAccount:${deployer}" --role "$role" --format=none
  done

  # Grants on individual secrets need setIamPolicy, not secret access.
  exists gcloud iam roles describe workspaceSecretIamManager --project "$project_id" ||
    run gcloud iam roles create workspaceSecretIamManager --project "$project_id" \
    --title "Workspace secret IAM manager" \
    --permissions secretmanager.secrets.get,secretmanager.secrets.getIamPolicy,secretmanager.secrets.setIamPolicy
  # Bound on each managed secret only, never project-wide.
  for secret_id in "${managed_secrets[@]}"; do
    run gcloud secrets add-iam-policy-binding "$secret_id" --project "$project_id" \
      --member "serviceAccount:${deployer}" \
      --role "projects/${project_id}/roles/workspaceSecretIamManager" --format=none
  done

  echo "== Deployer may attach only the Workspace runtime and invoker accounts"
  for account in "${runtime_accounts[@]}" "${invoker_accounts[@]}"; do
    run gcloud iam service-accounts add-iam-policy-binding "$(sa_email "$account")" \
      --project "$project_id" --member "serviceAccount:${deployer}" \
      --role roles/iam.serviceAccountUser --format=none
  done

  if [[ "$revoke_retired_edge_roles" == true ]]; then
    echo "== Retired deployer edge roles"
    retired_edge_roles=(roles/compute.loadBalancerAdmin roles/compute.securityAdmin)
    for role in "${retired_edge_roles[@]}"; do
      run_revoke gcloud projects remove-iam-policy-binding "$project_id" --condition=None --quiet \
        --member "serviceAccount:${deployer}" --role "$role" --format=none
    done
    print_command gcloud projects get-iam-policy "$project_id" \
      --flatten "bindings[].members" --filter "bindings.members:serviceAccount:${deployer}" \
      --format "value(bindings.role)"
    if [[ "$dry_run" == false ]]; then
      deployer_roles="$(gcloud projects get-iam-policy "$project_id" \
        --flatten "bindings[].members" --filter "bindings.members:serviceAccount:${deployer}" \
        --format "value(bindings.role)")" || fail "could not read back the deployer's project roles"
      for role in "${retired_edge_roles[@]}"; do
        ! grep -qxF "$role" <<<"$deployer_roles" || fail "the deployer still holds ${role}"
      done
      for role in roles/logging.viewer roles/cloudtrace.user roles/logging.configWriter; do
        grep -qxF "$role" <<<"$deployer_roles" || fail "the deployer lost ${role}"
      done
      echo "deployer holds no retired edge role and keeps log and trace access and scheduler alert permissions"
    fi
  fi
else
  echo "== Deploy roles not granted"
  echo "Run the smoke workflow, confirm an untrusted identity is denied, then rerun with --grant-deploy-roles."
fi

cat <<EOF

== Repository configuration (no secret values)
Run these as a repository maintainer, then protect the environment so only
${trusted_ref} can deploy to it:

gh api --method PUT repos/${github_repository}/environments/${environment_name}
gh variable set GCP_SANDBOX_PROJECT_ID --repo ${github_repository} --env ${environment_name} --body ${project_id}
gh variable set GCP_SANDBOX_WIF_PROVIDER --repo ${github_repository} --env ${environment_name} --body ${provider_name}
gh variable set GCP_SANDBOX_DEPLOY_SA --repo ${github_repository} --env ${environment_name} --body ${deployer}
gh variable set GCP_SANDBOX_STATE_BUCKET --repo ${github_repository} --env ${environment_name} --body ${state_bucket}

== Stack configuration identifiers
projectId: ${project_id}
projectNumber: ${project_number}
region: ${region}
stateBucket: ${state_bucket}
budget: ${max_spend} ${currency}, teardown ${teardown_date}

== Vercel Preview environment variables (no secret values)
WORKSPACE_GCP_PROJECT_NUMBER=${project_number}
WORKSPACE_WIF_POOL=${vercel_pool_id}
WORKSPACE_WIF_PROVIDER=${vercel_provider_id}
WORKSPACE_FRONTEND_SERVICE_ACCOUNT=$(sa_email "$frontend_account")
EOF
