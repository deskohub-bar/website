import type { OfficeReservationInput } from "@/features/reservation/office-reservation";
import { officeSelectionLink } from "@/features/reservation/office-selection-link";

// Compile-time fixtures for the restore contract: present, absent, and
// possibly absent values, with the restored type given explicitly or not.
// The arrow is never called.
declare const present: OfficeReservationInput;
declare const optional: OfficeReservationInput | undefined;
declare const context: Parameters<typeof officeSelectionLink.restore>[2];
const searchParams = new URLSearchParams();

void (() => {
  const restored: OfficeReservationInput = officeSelectionLink.restore(
    present,
    searchParams,
    context
  );
  const absent: undefined = officeSelectionLink.restore(
    undefined,
    searchParams,
    context
  );
  const explicitAbsent: undefined = officeSelectionLink.restore<undefined>(
    undefined,
    searchParams,
    context
  );
  const inferred: OfficeReservationInput | undefined =
    officeSelectionLink.restore(optional, searchParams, context);
  const explicit: OfficeReservationInput | undefined =
    officeSelectionLink.restore<OfficeReservationInput | undefined>(
      optional,
      searchParams,
      context
    );
  return [restored, absent, explicitAbsent, inferred, explicit];
});
