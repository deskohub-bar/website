import { Effect } from "effect";
import { AdministrationService } from "@/features/administration/administration.service";
import { defineAdministrationListExportRoute } from "@/features/administration/list-export.server";
import { getAdministrationReservationExportColumns } from "@/features/administration/reservation-export";
import { reservationListQuery } from "@/features/administration/reservation-list-query";
import {
  CoworkPassesReleaseGate,
  CoworkPassesReleaseGateForRun,
} from "@/features/passes/backend/cowork-passes-release-gate";

// The export reads Dotypos in sequence: the date range, then batches of
// bookings and customers. Each read can wait out the 30-second Dotypos request
// timeout and retry, which the default duration can't fit.
export const maxDuration = 300;

const exportReservations = defineAdministrationListExportRoute({
  columns: getAdministrationReservationExportColumns,
  name: "reservations",
  rows: Effect.fnUntraced(function* (params) {
    const includePassDays = yield* CoworkPassesReleaseGate.isOpen.pipe(
      Effect.provide(CoworkPassesReleaseGateForRun)
    );
    const administration = yield* AdministrationService;
    return yield* administration.exportReservations({
      ...reservationListQuery.parseExport(params),
      ...(includePassDays && { includePassDays: true }),
    });
  }),
});

export { exportReservations as GET };
