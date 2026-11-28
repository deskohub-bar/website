import { Effect } from "effect";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { getTeamTableSeatCapacities } from "./team-table-capacity";

export const loadAdvisoryTeamTableSeatCapacities =
  AdvisoryAvailabilityInventory.pipe(
    Effect.flatMap((inventory) => inventory.tables),
    Effect.flatMap(getTeamTableSeatCapacities),
    Effect.withSpan("team-table.loadAdvisorySeatCapacities")
  );
