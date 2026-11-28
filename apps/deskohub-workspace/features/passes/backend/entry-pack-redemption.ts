import {
  and,
  count,
  eq,
  gt,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Data, Effect } from "effect";
import {
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
} from "@/db/database.service";
import { customerAccounts } from "@/db/schema/customer-accounts";
import { passEntryClaims } from "@/db/schema/pass-entry-claims";
import { passPurchases } from "@/db/schema/pass-purchases";
import { workspaceReservations } from "@/db/schema/workspace-reservations";
import { WorkspaceLocks } from "@/db/workspace-locks";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { PlainDate } from "@/shared/utils/temporal";
import type { PassTier } from "../pass-offer";
import { hasClaimablePassOrder } from "./entry-pack-payment-eligibility";
import { getUnlimitedPassCoverageTiers } from "./unlimited-pass-window";

export class EntryPackUnavailableError extends Data.TaggedError(
  "EntryPackUnavailableError"
)<Record<string, never>> {}

export const entryPackUnavailableFailureCode = "entry_pack_unavailable";

export type EntryPackRedemption = {
  readonly passId: OrderId;
  readonly holderAccountId: CustomerAccountId;
  readonly date: PlainDate;
  readonly tier: PassTier;
};

export type EntryPackWithdrawalCancellation = {
  readonly passId: OrderId;
  readonly submittedOn: PlainDate;
};

/** Paid bookings through the withdrawal date are retained. Unspent holds end. */
export const isEntryPackClaimCancelledByWithdrawal = ({
  passId,
  submittedOn,
}: EntryPackWithdrawalCancellation) =>
  and(
    eq(passEntryClaims.passId, passId),
    or(
      eq(passEntryClaims.status, "reserved"),
      and(
        eq(passEntryClaims.status, "consumed"),
        gt(passEntryClaims.date, submittedOn)
      )
    )
  );

type EntryPackRequest = Omit<EntryPackRedemption, "tier">;

const passForBooking = (
  db: WorkspaceDatabaseClient,
  request: EntryPackRequest
) =>
  and(
    eq(passPurchases.id, request.passId),
    eq(passPurchases.product, "entry-pack"),
    eq(passPurchases.holderAccountId, request.holderAccountId),
    eq(passPurchases.status, "active"),
    or(
      isNull(passPurchases.giftIssuedAt),
      and(isNotNull(passPurchases.giftClaimedAt), hasClaimablePassOrder(db))
    ),
    sql`${passPurchases.validFrom} <= ${request.date} and ${request.date} < ${passPurchases.validUntil}`
  );

/** The same eligibility for a new quote, a new claim and a released claim. */
const requireAvailableEntry = Effect.fn("requireAvailableEntry")(function* (
  db: WorkspaceDatabaseClient,
  request: EntryPackRedemption,
  entryCount: number
) {
  const [used] = yield* db
    .select({ entries: count() })
    .from(passEntryClaims)
    .where(
      and(
        eq(passEntryClaims.passId, request.passId),
        ne(passEntryClaims.status, "released")
      )
    );
  if ((used?.entries ?? 0) >= entryCount) {
    return yield* new EntryPackUnavailableError({});
  }

  const [sameDate] = yield* db
    .select({ reservationId: passEntryClaims.reservationId })
    .from(passEntryClaims)
    .innerJoin(passPurchases, eq(passPurchases.id, passEntryClaims.passId))
    .where(
      and(
        eq(passPurchases.holderAccountId, request.holderAccountId),
        eq(passEntryClaims.date, request.date),
        ne(passEntryClaims.status, "released")
      )
    )
    .limit(1);
  if (
    sameDate ||
    (yield* getUnlimitedPassCoverageTiers(db, request)).has(request.tier)
  ) {
    return yield* new EntryPackUnavailableError({});
  }
});

/** Reads the holder's active pack. New quotes also check its remaining entries. */
export const loadEntryPackRedemption = Effect.fn("loadEntryPackRedemption")(
  function* (
    db: WorkspaceDatabaseClient,
    request: EntryPackRequest,
    forNewQuote = false
  ) {
    const [pass] = yield* db
      .select({
        tier: passPurchases.tier,
        entryCount: passPurchases.entryCount,
      })
      .from(passPurchases)
      .where(passForBooking(db, request));
    if (!pass || pass.entryCount === null) {
      return yield* new EntryPackUnavailableError({});
    }
    const redemption = { ...request, tier: pass.tier };
    if (forNewQuote)
      yield* requireAvailableEntry(db, redemption, pass.entryCount);
    return redemption;
  }
);

export const findReservationEntryClaim = Effect.fn("findReservationEntryClaim")(
  function* (
    db: WorkspaceDatabaseClient,
    reservationId: WorkspaceReservationId
  ) {
    const [claim] = yield* db
      .select()
      .from(passEntryClaims)
      .where(eq(passEntryClaims.reservationId, reservationId));
    return claim;
  }
);

/**
 * Checks availability under the locks used to admit a claim. The holder
 * lock serializes a date across packs. The pack row lock keeps its terms
 * stable while the ledger is counted.
 */
export const checkEntryPackClaim = Effect.fn("checkEntryPackClaim")(function* (
  reservationId: WorkspaceReservationId,
  request: EntryPackRequest & { readonly tier?: PassTier }
) {
  const { db } = yield* WorkspaceTransaction;
  yield* WorkspaceLocks.entryPackHolder(request.holderAccountId);
  // Unlimited activation, extension and reassignment take this same holder
  // row lock before adding coverage. Read it under the lock at admission.
  const [holder] = yield* db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(
      and(
        eq(customerAccounts.id, request.holderAccountId),
        isNull(customerAccounts.deletedAt)
      )
    )
    .for("no key update");
  if (!holder) return yield* new EntryPackUnavailableError({});

  const [pass] = yield* db
    .select({
      tier: passPurchases.tier,
      entryCount: passPurchases.entryCount,
    })
    .from(passPurchases)
    .where(passForBooking(db, request))
    .for("no key update");
  if (
    !pass ||
    pass.entryCount === null ||
    (request.tier && pass.tier !== request.tier)
  ) {
    return yield* new EntryPackUnavailableError({});
  }

  const [existing] = yield* db
    .select()
    .from(passEntryClaims)
    .where(eq(passEntryClaims.reservationId, reservationId));
  if (
    existing &&
    (existing.passId !== request.passId ||
      existing.date !== request.date ||
      existing.status === "consumed")
  ) {
    return yield* new EntryPackUnavailableError({});
  }
  // A claim that won admission can still finish. A released claim has to
  // qualify again, including against coverage added after the first hold.
  if (existing?.status === "reserved") return;
  yield* requireAvailableEntry(
    db,
    { ...request, tier: pass.tier },
    pass.entryCount
  );
});

export const reserveEntryPackClaim = Effect.fn("reserveEntryPackClaim")(
  function* (
    reservationId: WorkspaceReservationId,
    request: EntryPackRequest & { readonly tier?: PassTier }
  ) {
    const { db } = yield* WorkspaceTransaction;
    yield* checkEntryPackClaim(reservationId, request);
    yield* db
      .insert(passEntryClaims)
      .values({
        reservationId,
        passId: request.passId,
        date: request.date,
        status: "reserved",
      })
      .onConflictDoUpdate({
        target: passEntryClaims.reservationId,
        set: { status: "reserved" },
        setWhere: eq(passEntryClaims.status, "released"),
      });
  }
);

/** Re-admits only the original author, pass and date of a released claim. */
export const reserveReleasedEntryPackClaim = Effect.fn(
  "reserveReleasedEntryPackClaim"
)(function* (reservationId: WorkspaceReservationId) {
  const { db } = yield* WorkspaceTransaction;
  const [claim] = yield* db
    .select({
      passId: passEntryClaims.passId,
      date: passEntryClaims.date,
      holderAccountId: workspaceReservations.authorAccountId,
    })
    .from(passEntryClaims)
    .innerJoin(
      workspaceReservations,
      eq(workspaceReservations.id, passEntryClaims.reservationId)
    )
    .where(
      and(
        eq(passEntryClaims.reservationId, reservationId),
        eq(passEntryClaims.status, "released")
      )
    );
  if (!claim) return;
  if (!claim.holderAccountId) return yield* new EntryPackUnavailableError({});
  yield* reserveEntryPackClaim(reservationId, {
    ...claim,
    holderAccountId: claim.holderAccountId,
  });
});

export const releaseReservedEntryPackClaim = Effect.fn(
  "releaseReservedEntryPackClaim"
)(function* (reservationId: WorkspaceReservationId) {
  const { db } = yield* WorkspaceTransaction;
  yield* db
    .update(passEntryClaims)
    .set({ status: "released" })
    .where(
      and(
        eq(passEntryClaims.reservationId, reservationId),
        eq(passEntryClaims.status, "reserved")
      )
    );
});

/** Payment admission and spending serialize with withdrawal on the pack row. */
export const lockEntryPackForPayment = Effect.fn("lockEntryPackForPayment")(
  function* (passId: OrderId) {
    const { db } = yield* WorkspaceTransaction;
    const [pack] = yield* db
      .select({ status: passPurchases.status })
      .from(passPurchases)
      .where(eq(passPurchases.id, passId))
      .for("no key update");
    if (!pack || pack.status === "withdrawn") {
      return yield* new EntryPackUnavailableError({});
    }
  }
);

/** A paid write and the reserved entry it spends commit together. */
export const consumeEntryPackClaim = Effect.fn("consumeEntryPackClaim")(
  function* (reservationId: WorkspaceReservationId) {
    const { db } = yield* WorkspaceTransaction;
    const claim = yield* findReservationEntryClaim(db, reservationId);
    if (claim?.status === "released") {
      return yield* new EntryPackUnavailableError({});
    }
    if (claim?.status !== "reserved") return;
    yield* lockEntryPackForPayment(claim.passId);
    const [consumed] = yield* db
      .update(passEntryClaims)
      .set({ status: "consumed" })
      .where(
        and(
          eq(passEntryClaims.reservationId, reservationId),
          eq(passEntryClaims.status, "reserved")
        )
      )
      .returning({ reservationId: passEntryClaims.reservationId });
    if (!consumed) return yield* new EntryPackUnavailableError({});
    yield* db
      .update(passPurchases)
      .set({ status: "depleted" })
      .where(
        and(
          eq(passPurchases.id, claim.passId),
          eq(passPurchases.status, "active"),
          sql`${passPurchases.entryCount} = (
            select count(*) from ${passEntryClaims}
            where ${passEntryClaims.passId} = ${claim.passId}
              and ${passEntryClaims.status} = 'consumed'
          )`
        )
      );
  }
);
