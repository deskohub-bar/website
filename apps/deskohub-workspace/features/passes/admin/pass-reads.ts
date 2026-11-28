import {
  type DotyposCustomer,
  type DotyposCustomerId,
  getCustomerDisplayName,
} from "@deskohub/dotypos";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  WorkspaceDatabase,
  type WorkspaceDatabaseClient,
} from "@/db/database.service";
import { equalsAny } from "@/db/equals-any";
import { authUser } from "@/db/schema/auth";
import { contractWithdrawals } from "@/db/schema/contract-withdrawals";
import { customerAccounts } from "@/db/schema/customer-accounts";
import { legalEvidenceEvents } from "@/db/schema/legal-evidence-events";
import { orders } from "@/db/schema/orders";
import { passEntryClaims } from "@/db/schema/pass-entry-claims";
import { passPurchases } from "@/db/schema/pass-purchases";
import { paymentAttempts } from "@/db/schema/payment-attempts";
import { reservationAccessGrants } from "@/db/schema/reservation-access-grants";
import { workspaceReservations } from "@/db/schema/workspace-reservations";
import { AdministrationCustomerDirectory } from "@/features/administration/customer-directory.service";
import {
  isFindableAdministrationCustomer,
  nameAdministrationCustomer,
} from "@/features/administration/customer-identity";
import { type OrderId, orderIdSchema } from "@/features/order";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import type { Money } from "@/shared/money/money";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import { passDayMoveJournal } from "../backend/pass-day-move-journal";
import {
  type AdminPassListInput,
  type AdminPassPage,
  type AdminPassParty,
  type AdminPassStatus,
  type AdminPassSummary,
  adminPassPageSize,
} from "./pass-list-contract";

const buyerAccount = alias(customerAccounts, "pass_buyer");
const holderAccount = alias(customerAccounts, "pass_holder");
const buyerLogin = alias(authUser, "pass_buyer_login");
const holderLogin = alias(authUser, "pass_holder_login");
const winningAttempt = alias(paymentAttempts, "pass_winning_attempt");

const workspaceToday = currentInstant.pipe(
  Effect.map((now) =>
    plainDateStringSchema.make(getWorkspaceDate(now).toString())
  )
);

type PassDate = typeof plainDateStringSchema.Type;

/** Validity has an exclusive upper bound for both pass products. Preserve
 * explicit terminal states and derive calendar states for active rows. */
const statusOn = (today: PassDate) => sql<AdminPassStatus>`case
  when ${passPurchases.status} = 'active' and ${passPurchases.validUntil} <= ${today} then 'expired'
  when ${passPurchases.status} = 'active' and ${passPurchases.validFrom} > ${today} then 'scheduled'
  else ${passPurchases.status}
end`;

const isGift = ne(passPurchases.holderAccountId, passPurchases.buyerAccountId);
// The grant writer adds the complimentary order state. A zero-price checkout
// is still a purchase, so source does not follow the amount.
const complimentaryOrder = sql<boolean>`${orders.paymentState} = 'complimentary'`;
const paidOrder = and(
  sql`not (${complimentaryOrder})`,
  isNotNull(orders.paidAt)
);
const activeClaims = inArray(passEntryClaims.status, ["reserved", "consumed"]);
const passOrder = and(
  eq(orders.id, passPurchases.id),
  eq(orders.kind, "pass-purchase")
);
const passBuyerAccount = eq(buyerAccount.id, passPurchases.buyerAccountId);
const passHolderAccount = eq(holderAccount.id, passPurchases.holderAccountId);
const buyerEligible = and(
  isNull(buyerAccount.deletedAt),
  isNull(buyerLogin.deletionRequestedAt)
);
const holderEligible = and(
  isNull(holderAccount.deletedAt),
  isNull(holderLogin.deletionRequestedAt)
);
const buyerCustomerId = sql<DotyposCustomerId | null>`case when ${buyerEligible} then ${buyerAccount.dotyposCustomerId} end`;
const holderCustomerId = sql<DotyposCustomerId | null>`case when ${holderEligible} then ${holderAccount.dotyposCustomerId} end`;

const passRows = (db: WorkspaceDatabaseClient, today: PassDate) =>
  db
    .select({
      id: passPurchases.id,
      matchingCount: sql<number>`count(*) over ()`.mapWith(Number),
      product: passPurchases.product,
      tier: passPurchases.tier,
      entryCount: passPurchases.entryCount,
      entriesInUse: sql<number>`(${db
        .select({ count: count() })
        .from(passEntryClaims)
        .where(
          and(eq(passEntryClaims.passId, passPurchases.id), activeClaims)
        )})`.mapWith(Number),
      status: statusOn(today),
      storedStatus: passPurchases.status,
      validFrom: passPurchases.validFrom,
      validUntil: passPurchases.validUntil,
      accessEndsOn: passPurchases.accessEndsOn,
      gifted: sql<boolean>`${isGift}`,
      claimed: isNotNull(passPurchases.giftClaimedAt).mapWith(Boolean),
      buyerCustomerId,
      buyerDeletedAt: buyerAccount.deletedAt,
      buyerEmail: sql<
        string | null
      >`case when ${buyerEligible} then ${buyerLogin.email} end`,
      holderCustomerId,
      holderDeletedAt: holderAccount.deletedAt,
      holderEmail: sql<
        string | null
      >`case when ${holderEligible} then ${holderLogin.email} end`,
      winningPayment: {
        value: winningAttempt.amountValue,
        currency: winningAttempt.currency,
        exponent: winningAttempt.amountExponent,
        refundedValue: winningAttempt.refundedAmountValue,
      },
      unlimitedCoffee: passPurchases.unlimitedCoffee,
      unlimitedMonitorOption: passPurchases.unlimitedMonitorOption,
      complimentary: complimentaryOrder,
      paymentState: orders.paymentState,
      fulfillmentState: orders.fulfillmentState,
      activePaymentAttemptId: orders.activePaymentAttemptId,
      createdAt: passPurchases.createdAt,
      paidAt: orders.paidAt,
    })
    .from(passPurchases)
    .innerJoin(orders, passOrder)
    .leftJoin(
      winningAttempt,
      and(
        eq(winningAttempt.id, orders.activePaymentAttemptId),
        eq(winningAttempt.orderId, orders.id),
        eq(winningAttempt.state, "paid")
      )
    )
    .innerJoin(buyerAccount, passBuyerAccount)
    .innerJoin(holderAccount, passHolderAccount)
    .leftJoin(buyerLogin, eq(buyerLogin.id, buyerAccount.id))
    .leftJoin(holderLogin, eq(holderLogin.id, holderAccount.id))
    .$dynamic();

type PassRow = Effect.Success<ReturnType<typeof passRows>>[number];

type PassCustomerIds = Pick<PassRow, "buyerCustomerId" | "holderCustomerId">;

const passPartyIds = (rows: readonly PassCustomerIds[]) => [
  ...new Set(
    rows.flatMap(({ buyerCustomerId, holderCustomerId }) =>
      [buyerCustomerId, holderCustomerId].filter(
        (id): id is DotyposCustomerId => id !== null
      )
    )
  ),
];

const passParties = Effect.fn("administration.passParties")(function* (
  rows: readonly PassRow[],
  profiles?: ReadonlyMap<DotyposCustomerId, DotyposCustomer>
) {
  const directory = yield* AdministrationCustomerDirectory;
  const ids = passPartyIds(rows);
  const customers =
    profiles ??
    (ids.length
      ? yield* directory.findMany(ids)
      : new Map<DotyposCustomerId, DotyposCustomer>());
  const now = yield* DateTime.nowAsDate;
  return (
    customerId: DotyposCustomerId | null,
    email: string | null,
    deleted: boolean
  ): AdminPassParty => {
    const customer = customerId ? customers.get(customerId) : undefined;
    const name = customer ? nameAdministrationCustomer(customer, now) : null;
    const active = !deleted && name?.lifecycle === "active";
    const unlinkedEmail = !customerId && !deleted ? email : null;
    return {
      customerId: active ? customerId : null,
      name,
      email: active ? customer?.email?.trim() || email : unlinkedEmail,
      deleted,
    };
  };
});

const isIssuedPass = (status: PassRow["storedStatus"]) =>
  status !== "pending_payment" && status !== "void";

const toPassSummary = (
  row: PassRow,
  today: PassDate,
  party: (
    customerId: DotyposCustomerId | null,
    email: string | null,
    deleted: boolean
  ) => AdminPassParty
): AdminPassSummary => ({
  id: row.id,
  product: row.product,
  tier: row.tier,
  entryCount: row.entryCount,
  entriesLeft:
    row.entryCount === null
      ? null
      : Math.max(0, row.entryCount - Number(row.entriesInUse)),
  status: row.status,
  validFrom: row.validFrom,
  validUntil: row.validUntil,
  accessEndsOn: row.accessEndsOn,
  day:
    row.product === "unlimited" && row.status === "active"
      ? Temporal.PlainDate.from(row.validFrom).until(today).days + 1
      : null,
  complimentary: row.complimentary,
  claimed: isIssuedPass(row.storedStatus) ? !row.gifted || row.claimed : null,
  holder: party(
    row.holderCustomerId,
    row.holderEmail,
    row.holderDeletedAt !== null
  ),
  buyer:
    row.gifted && !row.complimentary
      ? party(row.buyerCustomerId, row.buyerEmail, row.buyerDeletedAt !== null)
      : null,
  paid:
    row.winningPayment && !row.complimentary
      ? {
          value: row.winningPayment.value,
          currency: row.winningPayment.currency,
          exponent: row.winningPayment.exponent,
        }
      : null,
});

const passSearch = Effect.fn("administration.passSearch")(function* (
  query: string,
  filters: SQL | undefined
) {
  const search = query.toLowerCase();
  const id = Schema.decodeOption(orderIdSchema)(search);
  if (Option.isSome(id)) {
    return { condition: eq(passPurchases.id, id.value), incomplete: false };
  }

  // Fetch profiles by existing linked IDs. The operator's input stays inside
  // Workspace, and unrelated directory records cannot crowd out a match.
  const { db } = yield* WorkspaceDatabase;
  const candidates = yield* db
    .selectDistinct({
      buyerCustomerId,
      holderCustomerId,
    })
    .from(passPurchases)
    .innerJoin(orders, passOrder)
    .innerJoin(buyerAccount, passBuyerAccount)
    .innerJoin(holderAccount, passHolderAccount)
    .leftJoin(buyerLogin, eq(buyerLogin.id, buyerAccount.id))
    .leftJoin(holderLogin, eq(holderLogin.id, holderAccount.id))
    .where(filters);
  const candidateIds = passPartyIds(candidates);
  const directory = yield* AdministrationCustomerDirectory;
  const profiles = candidateIds.length
    ? yield* directory.findMany(candidateIds)
    : new Map<DotyposCustomerId, DotyposCustomer>();
  const now = yield* DateTime.nowAsDate;
  const activeProfiles = [...profiles.values()].filter((profile) =>
    isFindableAdministrationCustomer(profile, now)
  );
  const matches = activeProfiles
    .filter((profile) =>
      [
        getCustomerDisplayName(profile),
        profile.companyName,
        profile.email,
      ].some((field) => field?.toLowerCase().includes(search))
    )
    .map(({ id }) => id);
  const activeIds = activeProfiles.map(({ id }) => id);

  // Invited holders can have a login before a Dotypos profile exists. A
  // linked login can match only after its profile was found to be active.
  // The sensitiveText encoder censors the bound email in each predicate.
  const emailMatch = search.includes("@")
    ? or(
        and(
          isGift,
          holderEligible,
          isNull(holderAccount.dotyposCustomerId),
          eq(holderLogin.email, search)
        ),
        activeIds.length
          ? or(
              and(
                buyerEligible,
                equalsAny(buyerAccount.dotyposCustomerId, activeIds),
                eq(buyerLogin.email, search)
              ),
              and(
                holderEligible,
                equalsAny(holderAccount.dotyposCustomerId, activeIds),
                eq(holderLogin.email, search)
              )
            )
          : undefined
      )
    : undefined;
  return {
    condition:
      or(
        emailMatch,
        matches.length
          ? or(
              and(
                buyerEligible,
                equalsAny(buyerAccount.dotyposCustomerId, matches)
              ),
              and(
                holderEligible,
                equalsAny(holderAccount.dotyposCustomerId, matches)
              )
            )
          : undefined
      ) ?? sql`false`,
    incomplete: candidateIds.some((id) => !profiles.has(id)),
    profiles,
  };
});

export const listAdminPasses = Effect.fn("administration.listAdminPasses")(
  function* (input: AdminPassListInput) {
    const { db } = yield* WorkspaceDatabase;
    const today = yield* workspaceToday;
    const page = input.page ?? 1;
    const source = {
      paid: paidOrder,
      gift: and(paidOrder, isGift),
      complimentary: complimentaryOrder,
    };
    const filters = and(
      input.product ? eq(passPurchases.product, input.product) : undefined,
      input.tier ? eq(passPurchases.tier, input.tier) : undefined,
      input.status ? eq(statusOn(today), input.status) : undefined,
      input.source ? source[input.source] : undefined
    );
    const search = input.query
      ? yield* passSearch(input.query, filters)
      : undefined;
    const rows = yield* passRows(db, today)
      .where(and(filters, search?.condition))
      .orderBy(desc(passPurchases.createdAt), desc(passPurchases.id))
      .limit(adminPassPageSize + 1)
      .offset((page - 1) * adminPassPageSize);
    const visible = rows.slice(0, adminPassPageSize);
    const party = yield* passParties(visible, search?.profiles);
    return {
      passes: visible.map((row) => toPassSummary(row, today, party)),
      total: rows[0]?.matchingCount ?? 0,
      hasNextPage: rows.length > adminPassPageSize,
      searchIncomplete: search?.incomplete ?? false,
    } satisfies AdminPassPage;
  }
);

export const readAdminCustomerPasses = Effect.fn(
  "administration.readAdminCustomerPasses"
)(function* (customerId: DotyposCustomerId) {
  const { db } = yield* WorkspaceDatabase;
  const today = yield* workspaceToday;
  const rows = yield* passRows(db, today)
    .where(
      or(
        and(holderEligible, eq(holderAccount.dotyposCustomerId, customerId)),
        and(
          buyerEligible,
          eq(buyerAccount.dotyposCustomerId, customerId),
          sql`not (${complimentaryOrder})`
        )
      )
    )
    .orderBy(desc(passPurchases.createdAt), desc(passPurchases.id));
  const visible = rows.filter((row) => isIssuedPass(row.storedStatus));
  const party = yield* passParties(visible);
  const purchases = visible.map((row) => ({
    row,
    pass: toPassSummary(row, today, party),
  }));

  // Spending follows the order even when its pass could not be fulfilled.
  // The winning attempt excludes rejected or superseded captures.
  const totals = new Map<string, Money>();
  for (const row of rows) {
    if (
      row.buyerCustomerId !== customerId ||
      row.complimentary ||
      !row.winningPayment
    )
      continue;
    const { currency, exponent, value, refundedValue } = row.winningPayment;
    const unit = `${currency}:${exponent}`;
    totals.set(unit, {
      currency,
      exponent,
      value:
        (totals.get(unit)?.value ?? 0) +
        Math.max(0, value - (refundedValue ?? 0)),
    });
  }
  return {
    held: purchases
      .filter(({ row }) => row.holderCustomerId === customerId)
      .map(({ pass }) => pass),
    boughtForOthers: purchases
      .filter(
        ({ row, pass }) =>
          row.buyerCustomerId === customerId &&
          pass.buyer !== null &&
          pass.paid !== null
      )
      .map(({ pass }) => pass),
    spent: [...totals.values()],
  };
});

export const readAdminPass = Effect.fn("administration.readAdminPass")(
  function* (passId: OrderId) {
    const { db } = yield* WorkspaceDatabase;
    const today = yield* workspaceToday;
    const [row] = yield* passRows(db, today).where(
      eq(passPurchases.id, passId)
    );
    if (!row) return null;
    const party = yield* passParties([row]);
    const moveJournal = passDayMoveJournal(db);
    const [attempts, consent, withdrawals, claims, days, moves] =
      yield* Effect.all(
        [
          db
            .select({
              id: paymentAttempts.id,
              state: paymentAttempts.state,
              provider: paymentAttempts.provider,
              providerOrderId: paymentAttempts.providerOrderId,
              refundState: paymentAttempts.refundState,
              refundTargetValue: paymentAttempts.refundTargetValue,
              refundedAmountValue: paymentAttempts.refundedAmountValue,
              refundedAt: paymentAttempts.refundedAt,
              value: paymentAttempts.amountValue,
              exponent: paymentAttempts.amountExponent,
              currency: paymentAttempts.currency,
              createdAt: paymentAttempts.createdAt,
            })
            .from(paymentAttempts)
            .where(eq(paymentAttempts.orderId, passId))
            .orderBy(desc(paymentAttempts.createdAt), desc(paymentAttempts.id)),
          db
            .select({
              id: legalEvidenceEvents.id,
              documentKey: legalEvidenceEvents.documentKey,
              documentPath: legalEvidenceEvents.documentPath,
              accepted: legalEvidenceEvents.accepted,
              acceptedAt: legalEvidenceEvents.acceptedAt,
              acknowledgements: legalEvidenceEvents.acknowledgements,
            })
            .from(legalEvidenceEvents)
            .where(eq(legalEvidenceEvents.orderId, passId))
            .orderBy(
              desc(legalEvidenceEvents.acceptedAt),
              desc(legalEvidenceEvents.id)
            ),
          db
            .select({
              submittedAt: contractWithdrawals.submittedAt,
              cancelledAt: contractWithdrawals.contractCancelledAt,
              value: contractWithdrawals.refundAmountValue,
              currency: contractWithdrawals.currency,
              exponent: contractWithdrawals.amountExponent,
            })
            .from(contractWithdrawals)
            .where(
              and(
                eq(contractWithdrawals.contractKind, "unlimited-pass"),
                eq(contractWithdrawals.contractId, passId)
              )
            ),
          db
            .select({
              date: passEntryClaims.date,
              reservationId: passEntryClaims.reservationId,
              status: passEntryClaims.status,
            })
            .from(passEntryClaims)
            .where(eq(passEntryClaims.passId, passId))
            .orderBy(
              desc(passEntryClaims.date),
              desc(passEntryClaims.reservationId)
            ),
          db
            .select({
              id: workspaceReservations.id,
              date: workspaceReservations.serviceDate,
              tableId: workspaceReservations.passDayTableId,
              accessIssued: isNotNull(reservationAccessGrants.issuedAt).mapWith(
                Boolean
              ),
              status: workspaceReservations.reservationState,
            })
            .from(workspaceReservations)
            .leftJoin(
              reservationAccessGrants,
              eq(
                reservationAccessGrants.workspaceReservationId,
                workspaceReservations.id
              )
            )
            .where(eq(workspaceReservations.passId, passId))
            .orderBy(
              workspaceReservations.serviceDate,
              workspaceReservations.id
            ),
          db
            .select({
              id: moveJournal.generation,
              date: workspaceReservations.serviceDate,
              sourceTableId: moveJournal.sourceTableId,
              targetTableId: moveJournal.targetTableId,
              requestedAt: moveJournal.requestedAt,
              attachedAt: moveJournal.attachedAt,
              ambiguousAt: moveJournal.ambiguousAt,
              settledAt: moveJournal.settledAt,
            })
            .from(moveJournal)
            .innerJoin(
              workspaceReservations,
              eq(workspaceReservations.id, moveJournal.reservationId)
            )
            .where(eq(workspaceReservations.passId, passId))
            .orderBy(
              desc(moveJournal.requestedAt),
              desc(moveJournal.generation)
            ),
        ],
        { concurrency: 3 }
      );
    return {
      pass: toPassSummary(row, today, party),
      storedStatus: row.storedStatus,
      today,
      accessEndsOn: row.accessEndsOn,
      paymentState: row.paymentState,
      fulfillmentState: row.fulfillmentState,
      activePaymentAttemptId: row.activePaymentAttemptId,
      createdAt: row.createdAt,
      paidAt: row.paidAt,
      coffee: row.unlimitedCoffee === true,
      monitor: row.unlimitedMonitorOption,
      attempts,
      consent,
      withdrawal: withdrawals[0] ?? null,
      claims,
      days,
      moves,
    };
  }
);

export type AdminPassDetail = NonNullable<
  Effect.Success<ReturnType<typeof readAdminPass>>
>;

export const readReservationPassLinks = Effect.fn(
  "administration.readReservationPassLinks"
)(function* (ids: readonly WorkspaceReservationId[]) {
  if (!ids.length)
    return new Map<WorkspaceReservationId, ReservationPassLink>();
  const { db } = yield* WorkspaceDatabase;
  const rows = yield* db
    .select({
      id: workspaceReservations.id,
      unlimitedId: workspaceReservations.passId,
      packId: passEntryClaims.passId,
    })
    .from(workspaceReservations)
    .leftJoin(
      passEntryClaims,
      and(
        eq(passEntryClaims.reservationId, workspaceReservations.id),
        activeClaims
      )
    )
    .where(inArray(workspaceReservations.id, ids));
  const links = new Map<WorkspaceReservationId, ReservationPassLink>();
  for (const row of rows) {
    if (row.unlimitedId)
      links.set(row.id, { product: "unlimited", passId: row.unlimitedId });
    else if (row.packId)
      links.set(row.id, { product: "entry-pack", passId: row.packId });
  }
  return links;
});

export type ReservationPassLink = {
  readonly product: AdminPassSummary["product"];
  readonly passId: OrderId;
};
