# Workspace protected-preview E2E

## Contents

- [How a run reaches a preview](#how-a-run-reaches-a-preview)
- [Nightly run](#nightly-run)
- [Run E2E](#run-e2e)
- [Environment contracts](#environment-contracts)
- [Preview database](#preview-database)
- [Protection and callbacks](#protection-and-callbacks)
- [CI workflow rules](#ci-workflow-rules)
- [Verify a change](#verify-a-change)

## How a run reaches a preview

`.github/workflows/workspace-e2e.yml` runs on the Vercel `repository_dispatch` events for the Workspace project's Preview environment:

1. Vercel builds the protected Git preview, and the Neon integration creates its database branch.
2. On `vercel.deployment.success`, the `resolve-target` job checks the project, environment, SHA, PR, URL, and the PR description's required `## E2E flows` section. It accepts only an open, internal, non-draft, non-Dependabot PR whose head is the target SHA, and resolves that PR before it checks the preview.
3. If `## E2E flows` is missing, empty, unknown, or mixes `all`/`none` with other flows, `resolve-target` fails closed and `publish-status-without-run` posts a failing `Workspace E2E` status. If it declares `none` (and the Vercel deployment succeeded or skipped), `test-e2e` is skipped with no shard lease and `Workspace E2E` passes as `Protected preview E2E skipped [flows: none]`.
4. Otherwise `test-e2e` leases a date shard and resolves the preview's Neon branch. It installs dependencies, migrates the branch, validates Dotypos capacity, and installs WebKit when `webkit` or `all` is selected or the checked-out commit predates `apps/deskohub-workspace/e2e/flows.ts`. It then runs `bun turbo test:e2e --filter=deskohub-workspace` with `WORKSPACE_E2E_FLOWS`.
5. `publish-final-status`, `publish-status-without-run`, and `sync-pr-e2e-flows` all publish `Workspace E2E` through `.github/actions/workspace-e2e-flows/publish-status.mjs`. Before any `success` status, the publisher requires affirmative live evidence of the PR head, valid `## E2E flows`, applicable Vercel preview deployment state (never treating an unreadable deployment as valid), and un-invalidated flow coverage, then performs post-write verification against fresh PR, deployment, and commit-status reads so a concurrent PR edit, validation failure, deployment failure, or active rerun cannot be left overwritten by a stale green status. Failed runs on the current head always record their actual run failure in commit-status history first and then reconcile against the live PR selection (for example `none` on a valid preview). If a run passed only a subset of the currently requested flows, `publish-final-status` publishes a `failure` status (`Protected preview E2E partial; more flows required`) that records the passed flows while keeping merge blocked.

`.github/workflows/workspace-e2e-pr-sync.yml` runs on `pull_request_target` (`opened`, `edited`, `reopened`, `ready_for_review`, `synchronize`) without checking out PR code. Its `validate-pr-e2e-flows` job checks `## E2E flows` for every open PR (including drafts, forks, Dependabot, and `synchronize` pushes) with minimal permissions (`contents: read`, `pull-requests: read`, `statuses: write`), failing `Workspace E2E` when invalid and never posting `success` for ineligible PRs. Its `sync-pr-e2e-flows` job runs on non-`synchronize` events for eligible internal non-draft PRs, gives a failed or unreadable preview deployment precedence over every flow selection, keeps active reruns pending instead of restoring older passes, preserves same-tree provenance when restoring carried coverage (including genuine partial passes on same-tree commits), and when a PR edit adds flows not yet covered on a built preview, immediately marks `Workspace E2E` failed and dispatches `workspace-e2e.yml` for only the missing real-run flows. When Vercel skipped building a preview for that SHA and no identical-tree commit covers the added flows, `Workspace E2E` fails asking to deploy its Workspace preview (CI holds no Vercel deploy credentials per `SKILL.md`; once Vercel builds that exact SHA, its `vercel.deployment.success` dispatch runs the requested flows automatically). Flow definitions, PR-body parsing, status encoding, and CAS status reconciliation live in `.github/actions/workspace-e2e-flows/{flows.mjs,cli.mjs,publish-status.mjs}` and `apps/deskohub-workspace/e2e/flows.ts`.

Valid `## E2E flows` values: `all`, `none`, or bullet items from `checkout-cowork`, `checkout-meeting-room`, `checkout-office`, `checkout-table`, `payments`, `discounts`, `referrals`, `agent-booking`, `account`, `admin`, `email-campaigns`, `access-codes`, `public-site`, `webkit`. Scheduled nightly runs in `workspace-e2e-nightly.yml` always execute `all` plus nightly cases.

A `Workspace E2E` success means E2E ran against that commit's code. For a deployment E2E doesn't run against, `resolve-target` checks the exact-SHA deployment status, decides the status in `Decide status without an E2E run`, and `publish-status-without-run` publishes it:

- `vercel.deployment.failed`: failure, asking for a fix or redeploy.
- `vercel.deployment.skipped`: Vercel compares a commit only with its parent, so a skip after a failed, unreported, or multi-commit push says nothing about tested code. The step reuses the result of the nearest other PR commit with the identical Git tree whose status a real run published (running, passed, or failed). A status an earlier skip carried forward doesn't count. A passed run becomes success, a failed run failure, and a run still in progress a failure that asks for a rerun of this check. With no such commit, the status is failure until a Workspace preview of that exact SHA builds in Vercel; its success event then runs E2E.

Once the target SHA is an eligible PR head, every outcome publishes a `Workspace E2E` status. When `resolve-target` fails after that, for example because GitHub has no deployment record matching the preview yet or the head is missing from the PR's commit list (GitHub lists at most 250), `publish-status-without-run` publishes a failure whose description says how to recover, usually by re-running the failed jobs. Statuses for skipped commits trust a run's description from `github-actions[bot]`. Any workflow allowed to write statuses could forge one, but it could as well post a passing `Workspace E2E` directly, so this trusts no more than the required status does.

Only `test-e2e` has a concurrency group, keyed by PR and SHA with `cancel-in-progress`, so only a duplicate run for the same SHA cancels another. Runs for different SHAs never cancel each other: a run can resolve its SHA as the head, stall, and reach `test-e2e` after a newer head's run started, and a group keyed by PR alone would then let it cancel the newer run. A superseded run stops itself instead, since every SHA of a PR shares its Neon preview branch:

- Before it leases a shard or migrates, `test-e2e` checks that its SHA is still the PR head. If it isn't, the job waits for the run to be cancelled.
- The date shard lease also holds the branch's preview database exclusively, from before the migration until the release step at the end of `test-e2e`. Cancellation is asynchronous, so a newer head's run waits in the allocator until the older run releases the lease or GitHub reports its attempt completed. A run waiting for its branch doesn't hold back other PRs. See [lease rules](suite-orchestration.md#date-shards-and-the-coordination-database).
- After the lease, `test-e2e` checks the head again. A run superseded while it waited fails at once, so its release step frees the database for the newer head's run.
- `cancel-superseded-run` runs beside `test-e2e`, polls the PR head, and cancels its own run once the head moves. It holds `actions: write`, so `test-e2e`, which runs exact-SHA code, doesn't. It doesn't rerun with "Re-run failed jobs", so a rerun attempt stops only at the start check.
- `publish-final-status` publishes a failed run's status as `Superseded by a newer PR head before E2E finished` when its SHA is no longer the head. Statuses are per SHA, so this never touches the newer head's status. A skip reusing a same-tree commit's result passes over such a run.

Never add a workflow-level group: it would cancel at scheduling time, before eligibility is known. Never infer a skip from changed paths or reuse an older preview.

The target is always the immutable `.vercel.app` deployment origin for the exact SHA, taken from the dispatch payload. Never scrape the Vercel PR comment or use a branch alias or custom domain.

## Nightly run

Nightly cases are too slow for the per-PR gate. They are listed in `workspaceE2ENightlyCaseIds` (`e2e/playwright-checkout/case-catalog.ts`) and run only when `WORKSPACE_E2E_NIGHTLY_CASES=true`; any other run reports them as skipped. The only nightly case is the automation journey, which waits up to one 15-minute engine tick. Don't add a path-based PR gate for it (D38).

Main deploys only to production, and E2E never runs there. The job in `.github/workflows/workspace-e2e-nightly.yml` runs only in the Deskohub source repository (GitHub repository ID `1015951989`), which has the Workspace preview integration. It runs at 02:30 UTC or on a manual dispatch from `main`. A dispatch from any other ref in that repository fails immediately.

1. It points the `e2e/nightly` branch at main's head. Only this workflow moves that branch. Vercel builds a preview when an existing branch moves, even to a commit it already deployed and even with the workflow's `GITHUB_TOKEN`. The first run created the branch at main's head, and Vercel built nothing, not even a skipped deployment. So when the branch is missing, the workflow creates it at main's parent and then moves it to main's head. If the branch is already at main's head with no Vercel deployment of it, the wait runs out: delete the branch and start the workflow again, or let the next run after main moves fix it.
2. It waits up to 40 minutes for Vercel's Git preview of that exact SHA. The Neon integration backs it with the persistent `preview/e2e/nightly` branch, which the E2E run migrates. When the head hasn't moved, it reuses that SHA's existing preview without a build.
3. It dispatches main's `workspace-e2e.yml` with `ref=e2e/nightly` and `include_nightly_cases=true`.

A skipped or failed preview fails the nightly workflow; it never tests another commit's preview. In nightly mode, `resolve-target` accepts no PR. It requires a `workflow_dispatch` whose SHA is both the `e2e/nightly` head and a commit of main. Vercel's own events for the branch are ineligible, even if a PR has that head. GitHub deployment records carry no branch, and the preview database is chosen by branch name. So before the suite starts, `Run checkout E2E` reads the deployment from the Vercel API and refuses one that wasn't built from `e2e/nightly` at the target SHA. It does that in its own script, the only step that holds `WORKSPACE_E2E_VERCEL_TOKEN`. Nightly runs publish no commit status, skip the PR-head checks, and don't run `cancel-superseded-run`. A nightly failure is the failed `Workspace E2E` run in Actions, plus the failed nightly workflow when the preview never came up; the repository has no other alerting.

Nightly cases never run against a PR (D38). `resolve-target` passes `include_nightly_cases` on to the suite only after the nightly-target checks. A dispatch that sets it for any other target fails before it resolves a PR, so that PR's required status is left alone. Change a nightly case on its PR with the colocated tests; the next nightly run covers it on main.

## Run E2E

- **Manual dispatch.** Run the workflow with `sha` (40 characters), `url` (immutable HTTPS deployment URL), and `ref` (internal PR head branch). The same PR guards apply, and the job fails before it allocates or mutates shared state unless GitHub deployment metadata records that URL as a successful Workspace deployment for that SHA. Set `cleanup_stale_e2e_reservations` only for an intentional stale-reservation cleanup (see [suite orchestration](suite-orchestration.md#dotypos-capacity-and-stale-reservations)).
- **Preview payment modes.** Set the Vercel Preview variable `WORKSPACE_PAYMENT_PROVIDER` before building the exact Git SHA. Use `mock` to verify the mock directly or `fallback` to start with Nexi and allow a qualifying checkout to continue with mock in the same run. Set the repository Actions variable `WORKSPACE_E2E_PAYMENT_PROVIDER` to the matching value for automatic runs. For a manual run, use `payment_provider` to override the repository variable. Before the workflow change merges, manually dispatch from the PR branch whose workflow defines the input. Repository dispatch loads the workflow from `main`. [Nexi sandbox restart](nexi-sandbox.md#sandbox-restart)

  ```bash
  gh workflow run workspace-e2e.yml --ref <branch> -f sha=<head> -f url=<immutable preview URL> -f ref=<branch> -f payment_provider=mock
  ```

- **Review screenshots.** To capture the opt-in synthetic account and administration screenshots, set `review_screenshots=true`. Campaign composer captures use the separate `campaign_screenshots=true` input. Dispatch using a workflow ref that contains the input you need (for a PR preview, the PR branch), and keep `sha`, `url`, and `ref` bound to the exact PR head and its immutable deployment. Wait for the Vercel-triggered run for that PR SHA to finish first: both runs share a PR-and-SHA concurrency group with cancellation enabled. This runs the full suite, re-posts the `Workspace E2E` and `Workspace E2E allocation` statuses, and uploads screenshots in the dedicated `workspace-account-review-<run>-<attempt>` artifact; the separate general E2E artifact is uploaded on failure. If the screenshot run fails, rerun it and confirm the required status is green before merging.
- If Vercel finishes a preview before an open internal PR exists for its SHA, the `repository_dispatch` E2E run skips with `No eligible open internal PR matches the exact deployment SHA`. Once the PR exists, restart it with the manual dispatch from `main`, using the exact SHA, immutable preview URL, and branch:

  ```bash
  gh workflow run workspace-e2e.yml --ref main -f sha=<head> -f url=<immutable preview URL> -f ref=<branch>
  ```
- **Local run against a preview.** With the same variables in [runner variables](#runner-variables) and the preview's exact `TARGET_SHA`, first run `bun --cwd apps/deskohub-workspace e2e:capacity`. Then run `bun turbo test:e2e --filter=deskohub-workspace` from the repository root. Account and referral fixture creation requires that command's private observation and stops at its 50-minute cutoff, including for direct local calls. See [fixture capacity admission](suite-orchestration.md#dotypos-capacity-and-stale-reservations). The E2E task depends on `i18n:compile` and `@deskohub/igloohome#generate`.
- **Instant navigation only.** `bun run test:instant-navigation` from `apps/deskohub-workspace`. Without `WORKSPACE_E2E_BASE_URL`, the Playwright configs start `turbo dev` and target `http://localhost:3000`, and the administration navigation skips because its seeded administrator needs a preview and its E2E database.
- **Accessibility audit, local.** `test:accessibility` starts `next dev` on port 3110 and reuses whatever already listens there, so check the port is free. A fresh worktree first needs the gitignored generated code: `bun run i18n:compile` and `bun run i18n:compile:administration`, `bun run temporal-polyfill:build` and `bun run booking-widget:build` in `apps/deskohub-workspace`, and `bun run generate` in `packages/ares`, `dotypos`, `games`, `igloohome` and `nexi` (the PostHog client is committed; its generate rewrites it). Without them every page renders Next's build-error overlay, whose `<html>` has no `lang`, and every case times out in `openSettledPage`. Point `WORKSPACE_TEST_DATABASE_URL`, `DATABASE_URL` and `DATABASE_URL_UNPOOLED` at a disposable `ghcr.io/fboulnois/pg_uuidv7:1.7.0` container (stock Postgres lacks `pg_uuidv7`), run `db:migrate`, then `bun --env-file=.env.local --env-file=.env.development.local run test:accessibility`. The full suite (682 cases, three workers) takes over an hour, and three workers peaked at 17 GB of memory plus 7 GB of swap on the devbox, so run it as a heavy step and narrow it with `--project` and `--grep`. On 2026-11-10 the reservation-form cases (`form` with `#reservation-submit` never found), the four email previews (120-second test timeout) and the cs-CZ and en-US form ARIA snapshots failed locally in every locale, also with one worker on an idle machine.

Bun loads dotenv files before the entry module runs. Email-provider secrets that exist only in Vercel are intentionally unavailable to local E2E.

## Environment contracts

Inspect settings and deployment metadata without printing values.

### Vercel Preview environment (Workspace project)

- Neon integration-managed `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
- Nexi sandbox `NEXI_API_ORIGIN` and `NEXI_API_KEY`, plus `NEXI_CHECKOUT_CURRENCY_OVERRIDE=EUR` for the current sandbox merchant.
- `WORKSPACE_PAYMENT_PROVIDER` defaults to `nexi`. The app accepts `mock` and `fallback` only on a protected Preview.
- E2E Dotypos URL, credentials, and tenant IDs. The E2E cloud needs at least one active percentage discount group between 0.01% and 90%; the runner picks one deterministically and fails closed when none exists.
- `EMAIL_API_KEY`. Env validation requires it in Preview and production. Recipient routing sends mail for `EMAIL_TEST_DOMAIN` recipients to Console, so E2E sends no real mail; a real person using a preview gets real mail.
- `EMAIL_CAMPAIGN_ADMIN_INBOX` set to an `@deskohub.test` address, so campaign test sends and their confirmation codes stay on Console and in the server logs. `EMAIL_CAMPAIGN_FROM` and `EMAIL_CAMPAIGN_REPLY_TO` are optional in Preview.
- `POSTHOG_FEATURE_FLAG_OVERRIDES={"calendar_sales":true,"customer_discounts":true,"discount_codes":true,"meeting_room_page":true,"office_page":true,"referrals":true,"webmcp_site_tools":true}`. The referral lane needs `referrals:true`, even when the production rollout is off. The site-tools lane (`e2e/instant-navigation/site-tools.pw.ts`) skips its registration cases unless `webmcp_site_tools` is on. The account lane skips the passkey cases unless `login_passkeys` is on, and the sign-in code case unless `login_email_code` is on; turn them on for a PR with a branch-scoped override. A branch-scoped override replaces the whole map, so include every flag. Set it before the preview is built; Vercel accepts a branch scope only after the branch is pushed.
- `GOOGLE_CALENDAR_SALES_ID` for the dedicated E2E sales calendar (see [fixtures](fixtures.md#calendar-sale-event)).
- `VERCEL_AUTOMATION_BYPASS_SECRET` for Deployment Protection.

Never put production Nexi, Dotypos, or database credentials in Preview. Never add callback-origin or BotID test overrides.

### GitHub `workspace-checkout-e2e` environment

| Name | Kind | Purpose |
| --- | --- | --- |
| `WORKSPACE_E2E_POSTHOG_PROJECT_TOKEN`, `WORKSPACE_E2E_POSTHOG_HOST` | Variables | Public ingest token and host for E2E traces. Management and trace-read keys stay secrets elsewhere. |
| `WORKSPACE_E2E_VERCEL_TOKEN` | Secret | Opaque token for the request-log history route; never enters Vercel or app config. |
| `WORKSPACE_E2E_VERCEL_PROJECT` | Variable | Project for log retrieval. |
| `WORKSPACE_E2E_COORDINATOR_DATABASE_URL` | Secret | Allocator role; used only by the trusted allocation action. |
| `WORKSPACE_E2E_PROVIDER_PERMIT_DATABASE_URL` | Secret | Connect-only role for the replay permit. |
| `WORKSPACE_E2E_BETTER_AUTH_SECRETS` | Secret | Copy of the shared Preview `BETTER_AUTH_SECRETS` for ordinary and nightly runs. Checkout, referral, and administrator tests use it for [seeded sessions](referral-lane.md#seeded-sessions). |
| `WORKSPACE_BACKEND_PREVIEW_BETTER_AUTH_SECRETS` | Secret | Dedicated signer for the approved backend pilot. Use the same versioned value in the exact pilot branch's Vercel Preview `BETTER_AUTH_SECRETS` and the pilot's GCP signing secret. The workflow validates it before acquiring the preview lease and passes it to the runner as `WORKSPACE_E2E_BETTER_AUTH_SECRETS`. |
| `WORKSPACE_E2E_CRON_SECRET` | Secret | Copy of the Preview-only `CRON_SECRET`. Vercel Cron never fires on previews, so the automation journey ticks the email automation planner through its cron route with this secret. Never copy the Production value; the journey fails closed without it. |
| `WORKSPACE_E2E_DOTYPOS_*` | Secrets | E2E Dotypos cloud; mapped to `DOTYPOS_*` per step. |
| `VERCEL_AUTOMATION_BYPASS_SECRET`, `NEON_API_KEY`, `TURBO_TOKEN` | Secrets | Protection bypass, branch lookup, remote cache. |

The optional backend preview pilot uses `workspace-backend-preview-e2e` for protected `main`. Its reviewed jobs verify the exact Vercel deployment and recheck the tested backend generation. They use the preview deployment metadata token and protection bypass. The candidate test job retains its existing preview fixtures. `Workspace backend preview proof` publishes pilot coverage only after GitHub concludes the exact `Workspace E2E` attempt successfully and confirms the same live generation. PR flow changes require a fresh pilot run.

### Runner variables

`e2e/e2e-env.ts` selects, validates, and decodes these once and passes typed config to telemetry, Layers, and child processes. The `test:e2e` entry in the root `turbo.json` lists them in `passThroughEnv`.

- `WORKSPACE_E2E_BASE_URL`: the one target origin. The runner validates it as an immutable HTTPS Vercel deployment and uses it for browser cases, availability, readiness, webhook replays, and checkout status.
- `WORKSPACE_E2E_PAYMENT_PROVIDER`: the expected preview mode, `nexi` by default. A manual run can choose `nexi`, `mock`, or `fallback` to override the repository Actions variable of the same name. Checkout and administrator navigation setup verify the value returned by the protected `GET /api/webhooks/nexi` before seeding data. A mismatch requires a preview built with the matching application setting or a run whose expected value matches that preview.
- `DATABASE_URL` (pooled), `WORKSPACE_E2E_DATABASE_URL_UNPOOLED`, `WORKSPACE_E2E_DATABASE_ALLOWLIST` (direct): must identify the database behind that same preview.
- `NEXI_API_ORIGIN`: the sandbox origin, supplied explicitly.
- `WORKSPACE_E2E_ALLOCATION_SHARD`, `WORKSPACE_E2E_PROVIDER_PERMIT_REQUIRED`, `WORKSPACE_E2E_PROVIDER_PERMIT_DATABASE_URL`: see [suite orchestration](suite-orchestration.md).
- `WORKSPACE_E2E_EXECUTION_CONTEXT`: `manual` or `ci`. Locally it defaults to `manual`; the workflow sets `manual` for `workflow_dispatch` and `ci` for the repository dispatch. A rerun keeps its trigger's value.
- `WORKSPACE_E2E_FLOWS`: optional `all`, `none`, or comma-separated flow IDs from `e2e/flows.ts`. Defaults to `all` when unset. Manual `workflow_dispatch` also accepts a `flows` input.
- `WORKSPACE_E2E_NIGHTLY_CASES=true`: also run the nightly cases (see [nightly run](#nightly-run)). The workflow sets it only for a validated nightly target dispatched with `include_nightly_cases`.
- `WORKSPACE_E2E_REVIEW_SCREENSHOTS=true`: opt-in general account PR review screenshots, including the administration Overview and customer calendar captures (see [browser driving](browser-driving.md#review-screenshots)). A manual workflow dispatch sets it only when `review_screenshots=true`; PR preview events leave it unset.
- `WORKSPACE_E2E_CAMPAIGN_REVIEW_SCREENSHOTS=true`: opt-in campaign-composer screenshots only. A manual workflow dispatch enables this with `campaign_screenshots=true`; it does not enable general account captures.

## Preview database

The Neon/Vercel integration owns the preview branch `preview/<internal-head-ref>`, including its creation and deletion. After `test-e2e` takes the preview lease and before it installs the candidate's dependencies, the workflow resolves the database.

1. Finds exactly one non-primary branch with that name using pinned `neonctl@2.30.1`, installed once.
2. Gets its direct and pooled connection strings and masks each at once.
3. Migrates with the direct URL (`bun run db:migrate`) before stale cleanup, capacity validation, and browser setup.

For the approved backend pilot, `resolve-backend-preview` waits for the exact backend revision before E2E takes the lease. Under the lease, `test-e2e` verifies the approved Neon branch and the same generation before migration. See the [backend preview pilot](../../deskohub-workspace-operations/references/backend-preview-pilot.md).

Runtime traffic uses the pooled URL; migrations, assertions, and the allowlist use the direct URL. The workflow fails closed when the branch is missing, ambiguous, primary, or mismatched. It never falls back to production or shared development. Don't create, expire, or delete integration-owned branches from the repository.

The preview is Ready before CI migrates it. Keep the Workspace build database-independent, and make schema changes compatible with that order. Don't add migrations to the Vercel build.

Production-derived preview branches may hold only the inherited Better Auth login email, pending-verification email, short-lived rate-limit IP keys, passkey rows (including customer-written labels), customer AI-agent OAuth consent, client, and token rows (including hashed tokens and the encrypted refresh replay copy), administrator role grants, and the administrator login-email snapshots in administrator provenance records. Everything else, including every fixture and all Dotypos profile and reservation data, is synthetic. Don't add a branch scrubber or an alternate parent branch.

Put database integration assertions inside the normal E2E runner and use its scoped `E2EDatabase` service. Don't add a dedicated script, Turbo task, file-naming convention, environment switch, or per-case database allowlist for them. Repository-level proofs that need no deployed app, such as invoice issuance, numbering, and immutability, belong in the owning repository's colocated `*.postgres.test.ts` instead: they need an exclusive database, and the shared preview branch can give them one only by serializing them after every paid case. E2E code may reuse application repositories only through their injectable service contracts; importing a contract must not initialize the app database pool, load the app keyring, or validate unrelated app variables.

## Protection and callbacks

- Browser navigation sets the bypass cookie. Readiness checks and direct webhook replays send `x-vercel-protection-bypass`. Workspace appends the bypass query parameter to preview Nexi result and notification URLs.
- Prime the bypass cookie with a stable public asset the app ships, and require success. A missing asset returns 404 even with a valid bypass.
- Playwright code primes it only through `primePreviewAccess` or `enablePreviewAccess` in `e2e/preview-access.ts`, or through `session.primePreviewAccess` on an `E2EBrowserSession`, which uses the same exchange once per origin. They send the secret only to an immutable Workspace deployment origin, exchange it for Vercel's `_vercel_jwt` cookie with a Node `fetch` outside Playwright, and add that cookie to the context. Never pass the secret to `context.request`, `extraHTTPHeaders`, or any other Playwright API: Playwright error messages echo request headers, and traces record them in the `.trace` and `.network` files. A raw trace still holds the cookie and the preview origin, so it never leaves the runner: see the Playwright trace rule below.
- Non-production callback origins come from `VERCEL_URL`; production uses `VERCEL_PROJECT_PRODUCTION_URL`.
- Preview visitor GET and HEAD navigation redirects to the immutable callback origin before sign-in and reservation preparation, so host-only session and checkout cookies live on the host Nexi returns to. The immutable-host suite doesn't cover this; when you change the boundary, check direct alias page loads and client navigation by hand.
- BotID runs only in Vercel production. Read the `deskohub-workspace-botid` skill before changing that boundary.
- Replay targets `/api/webhooks/nexi` or `/api/webhooks/mock-payment` according to the provider persisted for the attempt. The handler reads authoritative payment state from that provider.

## CI workflow rules

- The repository-dispatch workflow definition comes from the default branch even when the job checks out the PR SHA. Don't make exact-SHA validation depend on a workflow-level value changed in the same PR; keep expectations in the checked-out runner or in an already-compatible dispatch contract.
- When you add a runner-owned workflow variable, add it to `passThroughEnv` for `test:e2e` in the root `turbo.json` and test the workflow-to-task boundary. Turborepo's strict env mode drops it silently otherwise.
- The Bun package cache uses an exact `bun.lock` key with no restore keys. The `fill-bun-package-cache` job checks out the exact SHA, looks the key up, and on a miss copies `bun.lock`, tracked `package.json` files, and tracked `*.patch` files into `$RUNNER_TEMP`, runs `bun install --frozen-lockfile --ignore-scripts` there, and saves the entry. It runs no exact-SHA code, `bunfig.toml`, `.npmrc`, or lifecycle script; keep it that way, and extend `scripts/workspace-e2e-bun-cache-fill.test.ts` when you change the fill. `test-e2e` needs that job and only restores the entry. Never call `oven-sh/setup-bun` directly in this workflow: its post-job save would put a binary that exact-SHA code could replace into the default-branch scope every workflow restores from.
- `test-e2e` sets up Bun with `.github/actions/setup-bun`, checked out from `github.workflow_sha` with the allocation action, before any exact-SHA code runs. The action only restores the Bun release archive (keyed by Bun version, OS and architecture). On a miss it downloads the archive with `curl --retry-all-errors` and doubling waits. On a hit or a miss it installs the archive only if it matches the pinned `bun-sha256`, the `bun-linux-x64.zip` line of the release's `SHASUMS256.txt`. `setup-bun` with `no-cache` then reuses that binary. `.github/workflows/bun-release-cache.yml` saves the entry on `main` from main's code and restores it twice a week so it isn't evicted; a saved entry can't be overwritten. The restore extracts the whole entry before the digest check, so the entry's trust rests on that writer: never add a save of a `bun-release-*` key anywhere else. When you bump Bun, change the version and digest in both workflows; `scripts/workspace-e2e-workflow.test.ts` checks they match, and `scripts/setup-bun-action.test.ts` runs the download and install against a fake release host.
- The workflow sets `cache-mode: read`, so every job's token can restore but not save; only `fill-bun-package-cache` overrides it with `write`. Dispatch triggers otherwise default to `write` in the default-branch scope every workflow restores from, and exact-SHA code in `test-e2e` could tamper with a later action or read its token. Explicit saves in `test-e2e` would be refused, so never add one, and never use `actions/cache` there (its post-job save runs after everything). `scripts/workspace-e2e-workflow.test.ts` checks each job's effective mode and that the fill job holds the only save. Give a new cache a restore-only step in `test-e2e` and a writer that runs no exact-SHA code, like the fill job or the main-only writer below.
- The WebKit browser comes from `.github/actions/restore-playwright-webkit`, checked out from `github.workflow_sha` and run before `Install repository dependencies`. It reads the exact `@playwright/test` pin from `apps/deskohub-workspace/package.json` as data (a range fails the step) and restores `~/.cache/ms-playwright` under `workspace-e2e-playwright-webkit-<os>-<arch>-<ImageOS>-<version>`, with no restore keys. On a miss, `Install Workspace Playwright WebKit` downloads the browser as it always did. `.github/workflows/playwright-webkit-cache.yml` saves the entry on `main` from main's pin, when that pin, the action or the workflow changes, and restores it twice a week so it isn't evicted. Never add a save of a `workspace-e2e-playwright-webkit-*` key anywhere else (the new prefix only keeps old entries, which E2E runs saved after exact-SHA code, from being restored), keep the writer on E2E's runner (the key holds its image), and keep the pin exact; `scripts/restore-playwright-webkit-action.test.ts` checks the pin matches the installed version.
- The Playwright reporter writes each job's whole summary in the Playwright step. Don't assemble Markdown across steps; each step has its own `GITHUB_STEP_SUMMARY` file.
- Failure artifacts (`e2e-artifacts/**`) are kept for seven days. The repository is public, so they hold nothing a sanitized HAR wouldn't.
- Playwright traces are off except in the `webkit` project, which keeps one per failed test (`retain-on-failure`). The first reporter in `workspaceE2EPlaywrightReporter`, `e2e/playwright-trace-reporter.ts`, replaces each `trace.zip` with `sanitized-trace.zip` as the test ends (`e2e/playwright-trace-sanitizer.ts`, with the HAR rules from `e2e/artifact-sanitization.ts`). It fails closed: a trace it can't sanitize, or one that still holds a registered secret or the preview host, is deleted and the run output says so. The upload step excludes `trace*.zip` and Playwright's `.playwright-artifacts-*` working folders (a `maxFailures` stop can leave raw trace files there; hidden paths are also skipped by default), so nothing raw leaves the runner. At the end of the run it also deletes any `trace*.zip` no test reported. Screenshot pixels can't be redacted, so trace only pages that render no secret, the rule the failure screenshots already follow. The reporter runs in the runner process and knows only the bypass secret and the credentials the trace recorded, not secrets a worker registered. Before turning on a trace for another project, give the reporter that project's secrets, and keep new trace fields covered in `playwright-trace-sanitizer.test.ts` and `playwright-trace-sanitizer.browser-acceptance.test.ts`.

## Verify a change

Run from the repository root:

```bash
bun turbo i18n:compile --filter=deskohub-workspace
bun turbo test --filter=deskohub-workspace
bun turbo typecheck --filter=deskohub-workspace
bun turbo lint --filter=deskohub-workspace
git diff --check
```

`bun turbo test` generates the API clients and Paraglide output first. After that, run single files from `apps/deskohub-workspace` with `bun run test <path>`, which supplies the preload and `--parallel=1`.

For a deployed run, record only non-secret evidence:

1. The tested SHA equals the deployment SHA, and the target is the immutable deployment URL.
2. No deployment, alias, or domain change happened inside E2E.
3. The migrated Neon branch backs that preview and is neither production nor shared development.
4. Navigation passed Deployment Protection, the reported provider matched the run's selection before fixture seeding, and the hosted return and webhook replay reached that preview.
5. A deliberate case failure stops new admissions while running tests close their own browser contexts and clean up exactly.
