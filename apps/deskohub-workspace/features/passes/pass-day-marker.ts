import type { OrderId } from "@/features/order";

export const ambiguousPassDayHoldCode = "ambiguous_pass_day_hold";
export const rejectedPassDayHoldCode = "rejected_pass_day_hold";

const uuid = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
const passDayMarkerPattern = new RegExp(
  `^Deskohub Unlimited ${uuid}/\\d{4}-\\d{2}-\\d{2}(?:/${uuid})?$`
);

export const formatPassDayMarker = (
  passId: OrderId,
  serviceDate: Temporal.PlainDate,
  generation: string | null
) =>
  `Deskohub Unlimited ${passId}/${serviceDate}${generation ? `/${generation}` : ""}`;

export const readPassDayMarkers = (note: string | null | undefined) =>
  note?.split("\n").filter((line) => passDayMarkerPattern.test(line)) ?? [];
