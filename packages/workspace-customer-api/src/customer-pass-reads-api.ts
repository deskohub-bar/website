import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiSchema } from "effect/http-api";
import { CustomerAccountLinkRequired, Money } from "./customer-account-api";
import {
  CustomerBookableCoworkTier,
  CustomerBookingSelectionInvalid,
  CustomerCoworkStay,
  CustomerMonitorOption,
  CustomerPlainDate,
} from "./customer-booking-selection";
import { CustomerLocale } from "./customer-locale";
import { CustomerReservationOrderId } from "./customer-reservations-api";
import { CustomerServiceUnavailable } from "./customer-session";

export class CustomerPassesUnavailable extends Schema.TaggedError<CustomerPassesUnavailable>()(
  "CustomerPassesUnavailable",
  {}
) {
  static schema = this.pipe(HttpApiSchema.status("NotFound"));
}

/** The account has no permission to open a pass with this ID. */
export class CustomerPassNotFound extends Schema.TaggedError<CustomerPassNotFound>()(
  "CustomerPassNotFound",
  {}
) {
  static schema = this.pipe(HttpApiSchema.status("NotFound"));
}

export const CustomerPassId = Schema.String.check(Schema.isUUID()).annotate({
  identifier: "CustomerPassId",
  description: "Opaque identifier of a pass purchase order.",
});

export const CustomerPassTier = Schema.Literals([
  "open-space",
  "reserved-desk",
  "reserved-desk-workstation",
]).annotate({ identifier: "CustomerPassTier" });
export type CustomerPassTier = typeof CustomerPassTier.Type;

export const CustomerEntryPackSize = Schema.Literals([5, 10]);

const entryPackFields = {
  kind: Schema.Literal("entry-pack"),
  tier: CustomerPassTier,
  size: CustomerEntryPackSize,
};

export const CustomerEntryPackProduct = Schema.Struct(entryPackFields).annotate(
  { identifier: "CustomerEntryPackProduct" }
);

export const CustomerPassCatalog = Schema.Struct({
  entryPacks: Schema.Array(
    Schema.Struct({
      product: CustomerEntryPackProduct,
      price: Money,
      validityMonths: Schema.Int,
    })
  ),
  unlimited: Schema.Array(
    Schema.Struct({
      product: Schema.Struct({
        kind: Schema.Literal("unlimited"),
        tier: CustomerPassTier,
      }),
      price: Money,
      validityDays: Schema.Int,
    })
  ),
  unlimitedCoffeePrice: Money,
}).annotate({ identifier: "CustomerPassCatalog" });
export type CustomerPassCatalog = typeof CustomerPassCatalog.Type;

const passPeriod = {
  passId: CustomerPassId,
  tier: CustomerPassTier,
  validFrom: CustomerPlainDate,
  /** The last day the pass can be used, inclusive. */
  lastUsableDate: CustomerPlainDate,
};

const acquisition = {
  /** Absent for complimentary passes. */
  boughtOn: Schema.optionalKey(CustomerPlainDate),
  gift: Schema.optionalKey(
    Schema.Struct({ buyerName: Schema.optionalKey(Schema.String) })
  ),
};

const heldEntryPackStatus = Schema.Literals([
  "active",
  "expired",
  "depleted",
  "ended",
]);

const entryPackFieldsForHolder = {
  ...passPeriod,
  ...entryPackFields,
  entriesLeft: Schema.Int,
};

export const CustomerHeldEntryPack = Schema.Struct({
  ...entryPackFieldsForHolder,
  ...acquisition,
  status: heldEntryPackStatus,
  /** Dates already booked and confirmed on or after today in Prague. */
  bookedDates: Schema.Array(CustomerPlainDate),
  /** The first valid date without an existing claim, when the pack is usable. */
  bookFrom: Schema.optionalKey(CustomerPlainDate),
}).annotate({ identifier: "CustomerHeldEntryPack" });
export type CustomerHeldEntryPack = typeof CustomerHeldEntryPack.Type;

const unlimitedDay = {
  date: CustomerPlainDate,
  day: Schema.Int,
  totalDays: Schema.Int,
};

export const CustomerHeldUnlimitedPass = Schema.Struct({
  ...passPeriod,
  ...acquisition,
  kind: Schema.Literal("unlimited"),
  status: Schema.Literals(["upcoming", "active", "expired", "ended"]),
  today: Schema.optionalKey(Schema.Struct(unlimitedDay)),
  seatLabel: Schema.optionalKey(Schema.String),
  renewalPath: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "CustomerHeldUnlimitedPass" });
export type CustomerHeldUnlimitedPass = typeof CustomerHeldUnlimitedPass.Type;

export const CustomerPassList = Schema.Struct({
  held: Schema.Array(
    Schema.Union([CustomerHeldEntryPack, CustomerHeldUnlimitedPass])
  ),
  boughtForOthers: Schema.Array(
    Schema.Struct({
      passId: CustomerPassId,
      product: Schema.Union([
        CustomerEntryPackProduct,
        Schema.Struct({
          kind: Schema.Literal("unlimited"),
          tier: CustomerPassTier,
        }),
      ]),
      claimed: Schema.Boolean,
      canResend: Schema.Boolean,
      invitation: Schema.Literals(["not_sent", "pending", "sent", "failed"]),
      maskedHolderEmail: Schema.optionalKey(Schema.String),
    })
  ),
}).annotate({ identifier: "CustomerPassList" });
export type CustomerPassList = typeof CustomerPassList.Type;

export const CustomerPassBookingOptions = Schema.Struct({
  entryPacks: Schema.Array(Schema.Struct(entryPackFieldsForHolder)),
  suggestedPackId: Schema.optionalKey(CustomerPassId),
  unlimited: Schema.optionalKey(Schema.Struct(passPeriod)),
}).annotate({ identifier: "CustomerPassBookingOptions" });
export type CustomerPassBookingOptions = typeof CustomerPassBookingOptions.Type;

const limitedAccessDay = {
  ...passPeriod,
  ...unlimitedDay,
};

export const CustomerUnlimitedAccess = Schema.Union([
  Schema.Struct({
    ...passPeriod,
    state: Schema.Literals(["before-start", "ended"]),
  }),
  Schema.Struct({
    ...limitedAccessDay,
    state: Schema.Literals(["closed", "retry"]),
  }),
  Schema.Struct({
    ...limitedAccessDay,
    state: Schema.Literal("available"),
    code: Schema.String,
    endsAt: Schema.String,
    deskLabel: Schema.optionalKey(Schema.String),
  }),
]).annotate({ identifier: "CustomerUnlimitedAccess" });
export type CustomerUnlimitedAccess = typeof CustomerUnlimitedAccess.Type;

const readErrors = [
  CustomerPassesUnavailable.schema,
  CustomerAccountLinkRequired.schema,
  CustomerServiceUnavailable.schema,
] as const;

export const customerPassReadEndpoints = [
  HttpApiEndpoint.get("listPassOffers", "/catalog", {
    success: CustomerPassCatalog,
    error: readErrors,
  }),
  HttpApiEndpoint.get("listPasses", "/", {
    query: { locale: Schema.optionalKey(CustomerLocale) },
    success: CustomerPassList,
    error: readErrors,
  }),
  HttpApiEndpoint.get("getPassBookingOptions", "/options", {
    query: {
      date: CustomerPlainDate,
      tier: CustomerBookableCoworkTier,
      monitorOption: Schema.optionalKey(CustomerMonitorOption),
      stay: Schema.optionalKey(CustomerCoworkStay),
    },
    success: CustomerPassBookingOptions,
    error: [...readErrors, CustomerBookingSelectionInvalid.schema],
  }),
  HttpApiEndpoint.get("getUnlimitedAccess", "/:passId/access", {
    params: { passId: CustomerPassId },
    success: CustomerUnlimitedAccess,
    error: [...readErrors, CustomerPassNotFound.schema],
  }),
  HttpApiEndpoint.get("getReservationPassFunding", "/reservation-funding", {
    query: {
      orderIds: Schema.Array(CustomerReservationOrderId).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(50)
      ),
    },
    success: Schema.Struct({
      entryPackOrderIds: Schema.Array(CustomerReservationOrderId),
    }),
    error: readErrors,
  }),
  HttpApiEndpoint.post("resendPassInvitation", "/:passId/invitation", {
    params: { passId: CustomerPassId },
    success: Schema.Struct({
      status: Schema.Literals(["queued", "unavailable"]),
    }),
    error: readErrors,
  }),
] as const;
