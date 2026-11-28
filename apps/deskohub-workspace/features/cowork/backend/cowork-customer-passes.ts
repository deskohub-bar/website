import "server-only";

import { Effect, Option } from "effect";
import {
  WorkspaceDatabase,
  workspaceStatementConcurrency,
} from "@/db/database.service";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import type { CustomerAccountSession } from "@/features/account/backend/customer-authentication.service";
import {
  type CustomerAccountId,
  isCustomerAccountAccessDenial,
} from "@/features/account/customer-account";
import { isCurrentUnlimitedPass } from "@/features/passes/backend/customer-pass-coverage";
import { recoverEntryPackGiftClaims } from "@/features/passes/backend/entry-pack-gift";
import { listHeldEntryPacks } from "@/features/passes/backend/held-entry-packs";
import { listHeldUnlimitedPasses } from "@/features/passes/backend/held-unlimited-passes";
import { listUnlimitedPassCoverageWindows } from "@/features/passes/backend/unlimited-pass-window";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import { catchRecoverableCause } from "@/shared/backend/workspace-effect";
import { type PlainDate, plainDateStringSchema } from "@/shared/utils/temporal";
import {
  type CoworkEntryPacks,
  getCoworkBookingPasses,
  noCoworkBookingPasses,
} from "../cowork-entry-packs";

/** The customer's passes as the Cowork form uses them. */
export type CoworkCustomerPasses = {
  /** The Entry packs the customer can book with. */
  readonly bookingPasses: CoworkEntryPacks;
  /**
   * Whether the form offers passes to buy: not while the customer holds an
   * Unlimited pass the account page shows as active or upcoming.
   */
  readonly passPurchaseOffered: boolean;
};

/** A visitor without an active account has no pass and may buy one. */
const visitorCoworkPasses: CoworkCustomerPasses = {
  bookingPasses: noCoworkBookingPasses,
  passPurchaseOffered: true,
};

/**
 * What the form gets when a signed-in customer's passes can't be read: no
 * Entry pack to book with, and no pass to buy, since one they already hold
 * may cover the visit.
 */
export const unreadCoworkCustomerPasses: CoworkCustomerPasses = {
  bookingPasses: noCoworkBookingPasses,
  passPurchaseOffered: false,
};

/** Marks the dates on which an Unlimited pass leaves an Entry pack unusable. */
const withUnlimitedCoveredDates = Effect.fn("cowork.withUnlimitedCoveredDates")(
  function* (
    accountId: CustomerAccountId,
    today: PlainDate,
    booking: CoworkEntryPacks
  ) {
    const [firstPack] = booking.packs;
    if (!firstPack) return booking;

    const window = booking.packs.reduce(
      (range, pack) => ({
        validFrom:
          pack.validFrom < range.validFrom ? pack.validFrom : range.validFrom,
        validUntil:
          pack.validUntil > range.validUntil
            ? pack.validUntil
            : range.validUntil,
      }),
      { validFrom: firstPack.validFrom, validUntil: firstPack.validUntil }
    );
    const { db } = yield* WorkspaceDatabase;
    const coverage = yield* listUnlimitedPassCoverageWindows(db, accountId, {
      validFrom: window.validFrom > today ? window.validFrom : today,
      validUntil: window.validUntil,
      tiers: [...new Set(booking.packs.map((pack) => pack.tier))],
    });

    // Project only dates on which this Entry pack cannot be used.
    return {
      ...booking,
      packs: booking.packs.map((pack) => {
        const unavailableDates = new Set<PlainDate>();
        const packStart = pack.validFrom > today ? pack.validFrom : today;
        for (const covered of coverage) {
          if (covered.tier !== pack.tier) continue;
          const start =
            covered.validFrom > packStart ? covered.validFrom : packStart;
          const end =
            covered.validUntil < pack.validUntil
              ? covered.validUntil
              : pack.validUntil;
          for (
            let day = Temporal.PlainDate.from(start);
            day.toString() < end;
            day = day.add({ days: 1 })
          ) {
            unavailableDates.add(plainDateStringSchema.make(day.toString()));
          }
        }
        return unavailableDates.size > 0
          ? { ...pack, unavailableDates: [...unavailableDates] }
          : pack;
      }),
    };
  }
);

type RestoredEntryPack = Parameters<typeof getCoworkBookingPasses>[2];

/**
 * The Entry packs a signed-in customer can book with on the dates no
 * Unlimited pass covers. A failed read fails the load.
 */
const loadBookingPasses = ({
  accountId,
  today,
  restored,
}: {
  readonly accountId: CustomerAccountId;
  readonly today: PlainDate;
  readonly restored: RestoredEntryPack;
}) =>
  listHeldEntryPacks(accountId).pipe(
    Effect.map((held) => getCoworkBookingPasses(held, today, restored)),
    Effect.flatMap((booking) =>
      withUnlimitedCoveredDates(accountId, today, booking)
    )
  );

/**
 * Whether a signed-in customer holds no current Unlimited pass. A failed read
 * offers no pass to buy but leaves the Entry packs bookable, since each is
 * checked against Unlimited coverage on its own.
 */
const isPassPurchaseOffered = ({
  accountId,
  date,
}: {
  readonly accountId: CustomerAccountId;
  readonly date: Temporal.PlainDate;
}) =>
  listHeldUnlimitedPasses(accountId).pipe(
    Effect.map(
      (passes) => !passes.some((pass) => isCurrentUnlimitedPass(pass, date))
    ),
    catchRecoverableCause(() =>
      Effect.logWarning(
        "Held Unlimited passes could not be read; withholding pass offers.",
        { code: "cowork.unlimited-passes-unavailable" }
      ).pipe(Effect.as(false))
    )
  );

/** A signed-in customer's passes, read beside each other. */
const loadSignedInCustomerPasses = ({
  session: { accountId, verifiedSignInAt },
  restored,
}: {
  readonly session: CustomerAccountSession;
  readonly restored: RestoredEntryPack;
}) =>
  Effect.Do.pipe(
    Effect.let("date", () => getCurrentWorkspaceDate()),
    Effect.let("today", ({ date }) =>
      plainDateStringSchema.make(date.toString())
    ),
    Effect.tap(() => recoverEntryPackGiftClaims(accountId, verifiedSignInAt)),
    Effect.bind("concurrency", () => workspaceStatementConcurrency),
    Effect.bind("passes", ({ date, today, concurrency }) =>
      Effect.all(
        {
          bookingPasses: loadBookingPasses({ accountId, today, restored }),
          passPurchaseOffered: isPassPurchaseOffered({ accountId, date }),
        },
        { concurrency }
      )
    ),
    Effect.map(({ passes }): CoworkCustomerPasses => passes)
  );

/**
 * The customer's passes for the Cowork form. A visitor without an active
 * session, such as one signed out or awaiting deletion, may buy one; a
 * session that can't be read fails the load, so the page withholds every pass.
 */
export const loadCoworkCustomerPasses = (restored: RestoredEntryPack) =>
  Effect.Do.pipe(
    Effect.bind("account", () => CurrentCustomerAccount),
    Effect.bind("session", ({ account }) =>
      account.requireActive.pipe(
        Effect.asSome,
        Effect.catchIf(isCustomerAccountAccessDenial, () => Effect.succeedNone)
      )
    ),
    Effect.flatMap(({ session }) =>
      Option.match(session, {
        onNone: () => Effect.succeed(visitorCoworkPasses),
        onSome: (active) =>
          loadSignedInCustomerPasses({ session: active, restored }),
      })
    ),
    Effect.withSpan("cowork.loadCustomerPasses")
  );
