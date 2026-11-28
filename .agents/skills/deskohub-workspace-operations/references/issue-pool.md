# Deskohub issue pool

GitHub issues in `Deskohub/deskohub-site` are the shared backlog. `scripts/issue-pool/service.ts` resolves the canonical repository name from GitHub before collecting PostHog production errors, unresolved Workspace Vercel feedback, and nightly E2E diagnostics. It sorts source signals by priority, observation time, then source key. A report matches an open issue through stable source evidence. Later nightly runs add links to that issue. A recurrence after a fix can get a new issue when its observation is newer than the closure.

Nightly intake reads GitHub's case-failure annotations on trusted bot-dispatched Workspace runs from `main`. It accepts known diagnostic codes and timeouts that identify a case and step. Use the [failure triage guide](../../deskohub-workspace-e2e/references/failure-triage.md) for launcher, setup, and unclassified failures. Those failures stay in GitHub Actions for manual triage because the failing job alone can represent several distinct fixes.

The service checks the repository ID and Deskohub organization ownership before it accepts the canonical name. It uses immutable GitHub account IDs to check issue authors and comment markers. Filip (`totalolage`, ID `41711263`) is the designated maintainer and default reporter. To use a separate reporter, pass its numeric GitHub account ID with `--reporter-id` in the local service invocation. The active `gh` account must match the configured reporter before the pass begins. Only Filip can answer a worker's question through GitHub. He can enroll his own issue with the `issue-pool` label. When two approved issues refer to the same fix across sources, put the same `<!-- issue-pool-fix:<slug> -->` marker in both issue bodies. The dispatcher retains any existing owner across the group and otherwise selects the oldest eligible issue. Closing the owned issue covers siblings that were already open, and new evidence after closure can open a recurrence.

The service uses Bun, the authenticated `gh`, `posthog-cli`, and `vercel` clients, and the local T3 CLI. It starts standard T3 workers in separate worktrees from `origin/main` using the project defaults. Each worker invokes `$full-send` and settles its thread after verification and delivery. Each pass respects existing GitHub assignees, linked open PRs, and trusted worker markers. It adopts legacy PostHog issues by occurrence ID and stores the fingerprint association. It matches Vercel feedback by comment ID in GitHub and the existing track manifest.

## Preview a pass

Run this from the Deskohub checkout on the T3 host. Use an explicit app directory when invoking the Vercel collector so it finds the Workspace Vercel link.

```sh
bun scripts/issue-pool/service.ts \
  --project /home/dev/Projects/deskohub \
  --vercel-fetch-script /home/dev/.agents/skills/vercel-comments/scripts/fetch-comments.sh
```

The JSON summary records proposed issue keys, issue numbers, and groups of overlapping issues. Check `failedSources`, `pendingIntake`, `pendingAssignment`, and `pendingReply` before cutover. Pass the existing `--state` path to inspect persisted associations and reservations in read-only mode.

## Activate the timer

1. Verify the service revision is present in `/home/dev/Projects/deskohub` and a read-only pass reaches every source. Compare proposed issues with the existing collector evidence and verify that active Vercel and PostHog workers retain their claims.
2. Let the old collector passes finish. Pause the active `Run Vercel comments triage` and `PostHog dispatcher pass` T3 schedules before enabling the service. Check that any open issues awaiting a maintainer reply have a trusted worker marker and a `posthog-agent:human-needed` comment.
3. Install `scripts/issue-pool/deskohub-issue-pool.service` and `deskohub-issue-pool.timer` in the user systemd unit directory. Verify the paths in the unit match the host. Run `systemctl --user daemon-reload`, start the service once, and inspect its JSON summary. Verify any filed issue and assigned worker by number and link.
4. Enable the timer after the first pass. Use the service journal for the next pass and confirm repeated signals reuse their issues. Stop the timer before restoring either prior schedule.

## Reconcile ambiguous operations

Each mutating pass reserves its GitHub issue, worker assignment, or maintainer reply before making the external call. After an interruption, the service checks for the issue's source marker, the worker's title and branch, or the reply's comment ID marker in the same T3 thread. It writes the existing `posthog-agent:consumed-comment` marker after T3 accepts the reply. Keep the SQLite file in the unit's `StateDirectory` across restarts and upgrades.

A pending result with no matching external record needs an operator. Check GitHub issue bodies for the report and T3 for the exact issue number and `issue-pool/issue-<number>` branch. A worker launch may have accepted the request before the CLI returned. Inspect the service journal and the SQLite reservation before deciding whether to release it. Mutating a reservation while a pass is active can cause a duplicate.
