import { Schema } from "effect";
import { coworkReservationQuoteItemSchema } from "@/features/checkout/reservation-quote-cowork";
import { meetingRoomReservationQuoteItemSchema } from "@/features/checkout/reservation-quote-meeting-room";
import { officeReservationQuoteItemSchema } from "@/features/checkout/reservation-quote-office";
import { tableReservationQuoteItemSchema } from "@/features/checkout/reservation-quote-table";

export const reservationQuoteItemSchema = Schema.Union([
  coworkReservationQuoteItemSchema,
  meetingRoomReservationQuoteItemSchema,
  officeReservationQuoteItemSchema,
  tableReservationQuoteItemSchema,
]);
