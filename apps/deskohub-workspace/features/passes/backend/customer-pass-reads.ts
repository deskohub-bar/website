import "server-only";

import type {
  CustomerBookableCoworkTier,
  CustomerCoworkStay,
  CustomerHeldEntryPack,
  CustomerHeldUnlimitedPass,
  CustomerMonitorOption,
  CustomerPassBookingOptions,
  CustomerPassCatalog,
  CustomerPassList,
  CustomerReservationOrderId,
  CustomerUnlimitedAccess,
} from "@deskohub/workspace-customer-api";
import { and, eq, inArray } from "drizzle-orm";
import { Data, Effect, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { passEntryClaims, workspaceReservations } from "@/db/schema";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import {
  type BookableEntryPack,
  entryPackCoversDate,
  firstEntryPackDate,
  getCoworkBookingPasses,
  getOfferedEntryPack,
} from "@/features/cowork/cowork-entry-packs";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { catchRecoverableCause } from "@/shared/backend/workspace-effect";
import {
  currentInstant,
  type PlainDate,
  plainDateStringSchema,
} from "@/shared/utils/temporal";
import {
  entryPackOffers,
  getEntryPackLastUsableDate,
  unlimitedPassCoffeePrice,
  unlimitedPassOffers,
} from "../pass-offer";
import { getUnlimitedAccessPath, getUnlimitedRenewalPath } from "../routes";
import { isUnlimitedPassRenewalEligible } from "../unlimited-pass";
import { getUnlimitedPassAccessDay } from "../unlimited-pass-period";
import { CoworkPassesReleaseGate } from "./cowork-passes-release-gate";
import { recoverEntryPackGiftClaims } from "./entry-pack-gift";
import { getHeldEntryPackStatus, listHeldEntryPacks } from "./held-entry-packs";
import { listHeldUnlimitedPasses } from "./held-unlimited-passes";
import { readBoughtPassGifts, readHeldPassGiftBuyers } from "./pass-gift-reads";
import { loadUnlimitedAccess } from "./unlimited-access";
import { getUnlimitedPassCoverageTiers } from "./unlimited-pass-window";

export class CustomerPassesClosed extends Data.TaggedError(
  "CustomerPassesClosed"
)<Record<string, never>> {}

export class HeldPassNotFound extends Data.TaggedError("HeldPassNotFound")<
  Record<string, never>
> {}

export const requireCustomerPassAccount = Effect.fn(
  "CustomerPasses.requireActiveAccount"
)(function* () {
  if (!(yield* CoworkPassesReleaseGate.isOpen)) {
    return yield* new CustomerPassesClosed({});
  }
  return yield* Effect.flatMap(
    CurrentCustomerAccount,
    (account) => account.requireActive
  );
});

export const listCustomerPassOffers = Effect.fn("CustomerPasses.catalog")(
  function* () {
    yield* requireCustomerPassAccount();
    const catalog: CustomerPassCatalog = {
      entryPacks: entryPackOffers,
      unlimited: unlimitedPassOffers,
      unlimitedCoffeePrice: unlimitedPassCoffeePrice,
    };
    return catalog;
  }
);

export const listCustomerPasses = Effect.fn("CustomerPasses.list")(function* (
  locale: Locale
) {
  const { accountId, verifiedSignInAt } = yield* requireCustomerPassAccount();
  yield* recoverEntryPackGiftClaims(accountId, verifiedSignInAt);

  const [packs, unlimitedPasses, boughtForOthers, now] = yield* Effect.all(
    [
      listHeldEntryPacks(accountId),
      listHeldUnlimitedPasses(accountId),
      readBoughtPassGifts(accountId),
      currentInstant,
    ],
    { concurrency: "unbounded" }
  );
  const today = getWorkspaceDate(now);
  const todayString = plainDateStringSchema.make(today.toString());
  const bookable = getCoworkBookingPasses(packs, todayString);
  const [giftBuyers, desks] = yield* Effect.all(
    [
      readHeldPassGiftBuyers(accountId, [
        ...packs.map((pack) => pack.id),
        ...unlimitedPasses.map((pass) => pass.orderId),
      ]),
      unlimitedPasses.some((pass) => pass.deskId !== null)
        ? Effect.flatMap(
            AdvisoryAvailabilityInventory,
            (inventory) => inventory.tables
          ).pipe(catchRecoverableCause(() => Effect.succeed([])))
        : Effect.succeed([]),
    ],
    { concurrency: "unbounded" }
  );
  const deskNames = new Map(desks.map((desk) => [desk.id, desk.name?.trim()]));
  const gift = (passId: OrderId) => {
    const buyerName = giftBuyers.get(passId);
    return giftBuyers.has(passId)
      ? { gift: buyerName === undefined ? {} : { buyerName } }
      : {};
  };

  const heldPacks = packs.map((pack): CustomerHeldEntryPack => {
    const bookablePack = bookable.packs.find(({ id }) => id === pack.id);
    const bookFrom = bookablePack
      ? firstEntryPackDate(bookablePack, todayString, bookable.claimedDates)
      : undefined;
    return {
      ...bookingPack(pack),
      status: getHeldEntryPackStatus(pack, todayString),
      bookedDates: pack.bookedDates.filter((date) => date >= todayString),
      ...(!pack.complimentary && {
        boughtOn: getWorkspaceDate(pack.paidAt).toString(),
      }),
      ...gift(pack.id),
      ...(bookFrom && { bookFrom }),
    };
  });

  const heldUnlimited = unlimitedPasses.map(
    (pass): CustomerHeldUnlimitedPass => {
      const issued =
        pass.paymentState === "paid" || pass.paymentState === "complimentary";
      const accessDay = getUnlimitedPassAccessDay({ ...pass, date: today });
      const validUntil = pass.accessEndsOn ?? pass.validUntil;
      const status = getUnlimitedDisplayStatus(
        pass,
        todayString,
        issued,
        accessDay
      );
      const seatLabel = pass.deskId ? deskNames.get(pass.deskId) : undefined;
      return {
        passId: pass.orderId,
        kind: "unlimited",
        tier: pass.tier,
        validFrom: pass.validFrom,
        lastUsableDate: getEntryPackLastUsableDate(validUntil).toString(),
        status,
        ...(pass.paymentState === "paid" &&
          pass.paidAt && {
            boughtOn: getWorkspaceDate(pass.paidAt).toString(),
          }),
        ...gift(pass.orderId),
        ...(status === "active" &&
          accessDay && {
            today: { date: todayString, ...accessDay },
          }),
        ...(seatLabel && { seatLabel }),
        ...(pass.paymentState === "paid" &&
          !pass.renewalOverlaps &&
          isUnlimitedPassRenewalEligible(pass, now) && {
            renewalPath: getUnlimitedRenewalPath(locale, pass.orderId),
          }),
      };
    }
  );

  const result: CustomerPassList = {
    held: [...heldPacks, ...heldUnlimited],
    boughtForOthers: boughtForOthers.map(
      ({
        orderId,
        product,
        claimed,
        canResend,
        invitation,
        maskedHolderEmail,
      }) => ({
        passId: orderId,
        product,
        claimed,
        canResend: product.kind === "entry-pack" && canResend,
        invitation,
        ...(maskedHolderEmail && { maskedHolderEmail }),
      })
    ),
  };
  return result;
});

export const getCustomerPassBookingOptions = Effect.fn(
  "CustomerPasses.options"
)(function* (selection: {
  readonly date: string;
  readonly tier: CustomerBookableCoworkTier;
  readonly monitorOption?: CustomerMonitorOption;
  readonly stay?: CustomerCoworkStay;
}) {
  const { accountId, verifiedSignInAt } = yield* requireCustomerPassAccount();
  const date = yield* Schema.decodeUnknownEffect(plainDateStringSchema)(
    selection.date
  );
  yield* recoverEntryPackGiftClaims(accountId, verifiedSignInAt);
  const { db } = yield* WorkspaceDatabase;
  const [packs, unlimited, coveredTiers, now] = yield* Effect.all(
    [
      listHeldEntryPacks(accountId),
      listHeldUnlimitedPasses(accountId),
      getUnlimitedPassCoverageTiers(db, { holderAccountId: accountId, date }),
      currentInstant,
    ],
    { concurrency: "unbounded" }
  );
  const today = getWorkspaceDate(now).toString();
  const booking = getCoworkBookingPasses(packs, today);
  const dateForCoverage = Temporal.PlainDate.from(date);
  const coveredPasses =
    date >= today
      ? unlimited.filter(
          (pass) =>
            (pass.paymentState === "paid" ||
              pass.paymentState === "complimentary") &&
            getUnlimitedPassAccessDay({ ...pass, date: dateForCoverage }) !==
              undefined
        )
      : [];
  const usablePacks = booking.packs.filter(
    (pack) =>
      entryPackCoversDate(pack, date) &&
      !coveredTiers.has(pack.tier) &&
      (selection.stay !== "overnight" || pack.tier !== "open-space")
  );
  const canUseEntry = date >= today && !booking.claimedDates.includes(date);
  const suggested = canUseEntry
    ? getOfferedEntryPack(
        { ...booking, packs: usablePacks },
        {
          date,
          tier: selection.tier,
          workstation: selection.monitorOption !== undefined,
          workstationRequired: false,
        }
      )
    : undefined;
  const selectedTier =
    selection.tier === "reserved-desk" && selection.monitorOption
      ? "reserved-desk-workstation"
      : selection.tier;
  const covered =
    coveredPasses.find((pass) => pass.tier === selectedTier) ??
    coveredPasses[0];
  const result: CustomerPassBookingOptions = {
    entryPacks: canUseEntry ? usablePacks.map(bookingPack) : [],
    ...(suggested && { suggestedPackId: suggested.id }),
    ...(covered && {
      unlimited: {
        passId: covered.orderId,
        tier: covered.tier,
        validFrom: covered.validFrom,
        lastUsableDate: getEntryPackLastUsableDate(
          covered.accessEndsOn ?? covered.validUntil
        ).toString(),
      },
    }),
  };
  return result;
});

export const getCustomerUnlimitedAccessPath = Effect.fn(
  "CustomerPasses.accessPath"
)(function* (passId: OrderId, locale: Locale) {
  const { accountId, verifiedSignInAt } = yield* requireCustomerPassAccount();
  yield* recoverEntryPackGiftClaims(accountId, verifiedSignInAt);
  const held = yield* listHeldUnlimitedPasses(accountId);
  if (!held.some(({ orderId }) => orderId === passId)) {
    return yield* new HeldPassNotFound({});
  }
  return getUnlimitedAccessPath(locale, passId);
});

export const getCustomerUnlimitedAccess = Effect.fn("CustomerPasses.todayCode")(
  function* (passId: OrderId) {
    yield* requireCustomerPassAccount();
    const access = yield* loadUnlimitedAccess(passId);
    if (access.state === "not-found" || access.state === "sign-in") {
      return yield* new HeldPassNotFound({});
    }

    const period = {
      passId,
      tier: access.tier,
      validFrom: access.validFrom,
      lastUsableDate: getEntryPackLastUsableDate(access.validUntil).toString(),
    };
    if (!("date" in access)) {
      const result: CustomerUnlimitedAccess = {
        ...period,
        state: access.state,
      };
      return result;
    }
    const day = {
      ...period,
      date: access.date.toString(),
      day: access.day,
      totalDays: access.totalDays,
    };
    const result: CustomerUnlimitedAccess =
      access.state === "available"
        ? {
            ...day,
            state: access.state,
            code: access.code,
            endsAt: access.endsAt.toString(),
            ...(access.deskLabel && { deskLabel: access.deskLabel }),
          }
        : { ...day, state: access.state };
    return result;
  }
);

export const getCustomerReservationPassFunding = Effect.fn(
  "CustomerPasses.reservationFunding"
)(function* (orderIds: readonly CustomerReservationOrderId[]) {
  const { accountId } = yield* requireCustomerPassAccount();
  const { db } = yield* WorkspaceDatabase;
  const rows = yield* db
    .select({ orderId: workspaceReservations.id })
    .from(workspaceReservations)
    .innerJoin(
      passEntryClaims,
      eq(workspaceReservations.id, passEntryClaims.reservationId)
    )
    .where(
      and(
        eq(workspaceReservations.authorAccountId, accountId),
        eq(passEntryClaims.status, "consumed"),
        inArray(workspaceReservations.id, orderIds)
      )
    );
  return { entryPackOrderIds: rows.map(({ orderId }) => orderId) };
});

function bookingPack(pack: BookableEntryPack) {
  return {
    kind: "entry-pack" as const,
    passId: pack.id,
    tier: pack.tier,
    size: pack.entryCount,
    entriesLeft: pack.entriesLeft,
    validFrom: pack.validFrom,
    lastUsableDate: getEntryPackLastUsableDate(pack.validUntil).toString(),
  };
}

type HeldUnlimited = Effect.Success<
  ReturnType<typeof listHeldUnlimitedPasses>
>[number];

export function getUnlimitedDisplayStatus(
  pass: HeldUnlimited,
  today: PlainDate,
  issued: boolean,
  accessDay: ReturnType<typeof getUnlimitedPassAccessDay>
): CustomerHeldUnlimitedPass["status"] {
  if (accessDay && (pass.status !== "active" || issued)) return "active";
  if (pass.status === "expired") return "expired";
  if (pass.status !== "active") return "ended";
  if (today >= (pass.accessEndsOn ?? pass.validUntil)) return "expired";
  return issued && today < pass.validFrom ? "upcoming" : "ended";
}
