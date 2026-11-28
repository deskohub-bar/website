import { Data, Effect } from "effect";
import { ReleaseGate } from "@/features/feature-flags/backend/release-gate";

/** `team_table_page`: the Team Table page and reservations. */
export class TeamTableReleaseGate extends ReleaseGate<TeamTableReleaseGate>()(
  "@deskohub-workspace/team-table/TeamTableReleaseGate",
  "team_table_page"
) {}

class TeamTableReservationsDisabledError extends Data.TaggedError(
  "TeamTableReservationsDisabledError"
)<{
  readonly message: string;
}> {}

export const ensureTeamTableReservationsEnabled =
  TeamTableReleaseGate.isOpen.pipe(
    Effect.filterOrFail(
      (open) => open,
      () =>
        new TeamTableReservationsDisabledError({
          message: "Team Table reservations are disabled.",
        })
    ),
    Effect.asVoid
  );
