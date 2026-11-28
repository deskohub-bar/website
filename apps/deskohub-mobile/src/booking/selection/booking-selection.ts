import type {
  CustomerAvailabilityQuery,
  CustomerBookingSelection,
  CustomerTeamTableSelection,
} from "@deskohub/workspace-customer-api";
import { Data } from "effect";
import type { ReservationKind } from "../../analytics/events";
import type { PragueDate } from "./prague-date";

export type BookingSelection =
  | CustomerBookingSelection
  | CustomerTeamTableSelection;
export type BookingFamily = BookingSelection["family"];

export const isEntryPassBooking = (selection: BookingSelection): boolean =>
  selection.family !== "table" && selection.funding?.kind === "entry";

/** An availability request, as the booking contract's query takes it. */
export type AvailabilityQuery = typeof CustomerAvailabilityQuery.Type;

/**
 * The dates a selection screen's calendar offers: `earliest` through
 * `latest`, inclusive, without the `unavailable` ones.
 */
export type DateChoice = {
  readonly earliest: PragueDate;
  readonly latest: PragueDate;
  readonly unavailable: ReadonlySet<string>;
};

/** A draft that can't name a booking yet: `missing` lists what it lacks. */
export class SelectionIncomplete extends Data.TaggedClass(
  "SelectionIncomplete"
)<{ readonly missing: ReadonlyArray<keyof CustomerBookingSelection> }> {}

// The scalar fields in key order. The family and funding have their own
// encoding below. Typecheck names a field the contract adds.
const selectionKeyFieldOrder: Record<
  Exclude<keyof CustomerBookingSelection, "family" | "funding">,
  true
> = {
  date: true,
  endDate: true,
  startTime: true,
  duration: true,
  tier: true,
  stay: true,
  monitorOption: true,
  seats: true,
  coffee: true,
};
const selectionKeyFields = Object.keys(selectionKeyFieldOrder) as ReadonlyArray<
  keyof typeof selectionKeyFieldOrder
>;

/**
 * A stable string for one selection, the same for equal selections however
 * their objects were built, so quotes can be cached per selection.
 */
export const selectionKey = (selection: BookingSelection): string =>
  selection.family === "table"
    ? [
        selection.family,
        selection.date,
        selection.seats,
        selection.startTime,
        selection.endTime,
      ].join("&")
    : [
        selection.family,
        ...selectionKeyFields.flatMap((field) => {
          const value = selection[field];
          return value === undefined ? [] : [`${field}=${String(value)}`];
        }),
        ...(selection.funding
          ? [`funding=${selection.funding.kind}:${selection.funding.passId}`]
          : []),
      ].join("&");

/**
 * The selection without the options it spells out as `undefined`. Equal
 * selections share one quote, and a request can encode an absent option only
 * by leaving it out.
 */
export const withoutAbsentOptions = <Selection extends BookingSelection>(
  selection: Selection
): Selection =>
  Object.fromEntries(
    Object.entries(selection).filter(([, value]) => value !== undefined)
  ) as Selection;

const reservationKinds: Record<BookingFamily, ReservationKind> = {
  cowork: "cowork",
  "meeting-room": "meeting_room",
  office: "office",
  table: "table",
};

/** The analytics reservation kind of an API reservation family. */
export const reservationKindOf = (family: BookingFamily): ReservationKind =>
  reservationKinds[family];
