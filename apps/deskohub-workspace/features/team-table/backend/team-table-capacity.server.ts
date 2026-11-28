import "server-only";

import { DotyposService } from "@deskohub/dotypos";
import { Effect } from "effect";
import { getTeamTableSeatCapacities } from "./team-table-capacity";

export const loadTeamTableSeatCapacities = Effect.fn(
  "team-table.loadSeatCapacities"
)(function* () {
  const dotypos = yield* DotyposService;
  return yield* getTeamTableSeatCapacities(yield* dotypos.getTables());
});
