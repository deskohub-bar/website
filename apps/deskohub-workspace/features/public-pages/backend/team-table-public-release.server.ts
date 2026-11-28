import "server-only";

import { releaseGateForRequest } from "@/features/feature-flags/backend/release-gate.server";
import { TeamTableReleaseGate } from "@/features/team-table/backend/team-table-release-gate";

const teamTableRequest = releaseGateForRequest(TeamTableReleaseGate, {
  operation: "team-table.page-enabled",
  whenRunFails: "reject",
});

export const isTeamTablePageEnabled = teamTableRequest.decision;
export const TeamTableReleaseGateRequest = teamTableRequest.layer;
