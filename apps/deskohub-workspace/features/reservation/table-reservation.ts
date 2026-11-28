import {
  tableDurationMinutesSchema,
  tableSeatsSchema,
  type WorkspaceTableProductIdentity,
  workspaceTableProductIdentitySchema,
} from "@deskohub/workspace-domain/features/reservation/table-reservation-product";
import { Schema, SchemaGetter } from "effect";
import {
  defaultReservationBillingSelection,
  normalizedReservationBillingSelectionSchema,
  reservationBillingSelectionInputSchema,
} from "@/features/reservation/reservation-billing";
import {
  normalizedReservationCustomerSchema,
  reservationCustomerSchema,
} from "@/features/reservation/reservation-contact";
import { instantStringSchema } from "@/shared/utils/temporal";
import { tableReservationKind } from "./reservation-kind";
import {
  getTableReservationDurationMinutes,
  isTableReservationInterval,
} from "./table-reservation-time";

export const tableReservationDetailsSchema = Schema.Struct({
  kind: workspaceTableProductIdentitySchema.fields.kind,
  seats: tableSeatsSchema,
  startsAt: instantStringSchema,
  endsAt: instantStringSchema,
});

export type TableReservationDetails = typeof tableReservationDetailsSchema.Type;

export const tableAdvertisedPriceReservationSchema = Schema.Struct({
  kind: tableReservationDetailsSchema.fields.kind,
  details: tableReservationDetailsSchema.check(
    Schema.makeFilter((reservation) => isTableReservationInterval(reservation))
  ),
});

export type TableAdvertisedPriceReservation =
  typeof tableAdvertisedPriceReservationSchema.Type;

export const tableAdvertisedPriceReservationEquals = Schema.toEquivalence(
  tableAdvertisedPriceReservationSchema
);

export const getTableReservationDetails = ({
  kind,
  seats,
  startsAt,
  endsAt,
}: TableReservationDetails): TableReservationDetails => ({
  kind,
  seats,
  startsAt,
  endsAt,
});

export const getTableAdvertisedPriceReservation = (
  reservation: TableReservationDetails
): TableAdvertisedPriceReservation => ({
  kind: reservation.kind,
  details: getTableReservationDetails(reservation),
});

export const getTableReservationProductIdentity = (
  reservation: TableReservationDetails
): WorkspaceTableProductIdentity =>
  workspaceTableProductIdentitySchema.make({
    kind: tableReservationKind,
    seats: reservation.seats,
    durationMinutes: getTableReservationDurationMinutes(reservation),
  });

export const storedTableReservationDetailsSchema = Schema.Struct({
  kind: workspaceTableProductIdentitySchema.fields.kind,
  seats: Schema.optionalKey(tableSeatsSchema),
  durationMinutes: Schema.optionalKey(tableDurationMinutesSchema),
});

export type StoredTableReservationDetails =
  typeof storedTableReservationDetailsSchema.Type;

export const getStoredTableReservationDetails = (
  reservation: TableReservationDetails
): StoredTableReservationDetails =>
  getTableReservationProductIdentity(reservation);

export const normalizedTableReservationOrderSchema = Schema.Struct({
  ...tableReservationDetailsSchema.fields,
  ...normalizedReservationCustomerSchema.fields,
  billing: normalizedReservationBillingSelectionSchema,
});

export type NormalizedTableReservationOrder =
  typeof normalizedTableReservationOrderSchema.Type;

export const tableReservationOrderSchema = (defaultPhoneRegion: string) => {
  const inputSchema = Schema.Struct({
    ...tableReservationDetailsSchema.fields,
    ...reservationCustomerSchema(defaultPhoneRegion).fields,
    billing: reservationBillingSelectionInputSchema,
  }).check(
    Schema.makeFilter((reservation) => isTableReservationInterval(reservation))
  );
  return inputSchema.pipe(
    Schema.decodeTo(normalizedTableReservationOrderSchema, {
      decode: SchemaGetter.transform((reservation) => ({
        ...reservation,
        billing: reservation.billing ?? defaultReservationBillingSelection,
      })),
      encode: SchemaGetter.transform(Schema.decodeUnknownSync(inputSchema)),
    })
  );
};
