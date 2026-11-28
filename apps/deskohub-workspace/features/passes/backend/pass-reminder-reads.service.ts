import "server-only";

import type { DotyposCustomerId, DotyposTableId } from "@deskohub/dotypos";
import {
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  ne,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import {
  WorkspaceDatabase,
  type WorkspaceDatabaseClient,
} from "@/db/database.service";
import {
  contractWithdrawals,
  customerAccounts,
  orders,
  passEntryClaims,
  passPurchases,
  workspaceReservations,
} from "@/db/schema";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import { hasVerifiedActiveLogin } from "@/features/account/backend/customer-account-by-email";
import type { CustomerAccountId } from "@/features/account/customer-account";
import type { OrderId } from "@/features/order";
import { AdvisoryAvailabilityInventory } from "@/features/reservation/backend/availability-inventory";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { currentInstant, type PlainDate } from "@/shared/utils/temporal";
import type { EntryPackSize, PassTier } from "../pass-offer";
import {
  getPassReminderDueAt,
  getPassReminderEndDates,
  type PassReminderKind,
} from "../pass-reminder-schedule";
import { hasClaimablePassOrder } from "./entry-pack-payment-eligibility";
import { hasPendingPassChange } from "./pass-administration-pending";
import { hasUnlimitedRenewalOverlap } from "./unlimited-pass-window";

type PassReminderHolder = {
  readonly holderAccountId: CustomerAccountId;
  readonly holderVersion: number;
};

export type PassReminderCandidate = PassReminderHolder & {
  readonly passId: OrderId;
  readonly dotyposCustomerId: DotyposCustomerId;
  readonly tier: PassTier;
  readonly validFrom: PlainDate;
  /** Exclusive Prague date boundary. */
  readonly validUntil: PlainDate;
  readonly lastUsableDate: PlainDate;
} & (
    | {
        readonly kind: "entry-pack";
        readonly entriesLeft: number;
        readonly packSize: EntryPackSize;
      }
    | {
        readonly kind: "unlimited";
        readonly nextPeriodStart: PlainDate;
        readonly deskLabel?: string;
      }
  );

type PassReminderDue = {
  readonly kind: PassReminderKind;
  readonly dueDate: PlainDate;
  readonly now: Temporal.Instant;
};

export type ListDuePassReminders = PassReminderDue & {
  readonly afterPassId?: OrderId;
  /** Preview the date using current eligibility before the delivery time. */
  readonly preview?: true;
};

export type ReadDuePassReminder = PassReminderDue &
  PassReminderHolder & {
    readonly passId: OrderId;
    /** Delivery preparation can request the advisory label outside a transaction. */
    readonly includeDeskLabel?: true;
  };

export const passReminderPageSize = 100;

interface IPassReminderReads {
  readonly listDue: (
    input: ListDuePassReminders
  ) => Effect.Effect<readonly PassReminderCandidate[], DatabaseQueryError>;
  readonly readDue: (
    input: ReadDuePassReminder
  ) => Effect.Effect<Option.Option<PassReminderCandidate>, DatabaseQueryError>;
}

export class PassReminderReads extends Context.Service<
  PassReminderReads,
  IPassReminderReads
>()("PassReminderReads") {
  static Default = Layer.effect(
    PassReminderReads,
    Effect.gen(function* () {
      const { db } = yield* WorkspaceDatabase;
      const inventory = yield* AdvisoryAvailabilityInventory;
      const loadDeskLabels = inventory.tables.pipe(
        Effect.timeout("3 seconds"),
        Effect.map(
          (tables) => new Map(tables.map(({ id, name }) => [id, name?.trim()]))
        ),
        Effect.orElseSucceed(() => undefined)
      );

      const listDue = Effect.fn("PassReminderReads.listDue")(function* (
        input: ListDuePassReminders
      ) {
        const rows = yield* queryDuePasses(db, input);
        return rows.flatMap((row) => toCandidate(row) ?? []);
      });

      const readWithDeskLabel = Effect.fn(
        "PassReminderReads.readWithDeskLabel"
      )((input: ReadDuePassReminder) =>
        Effect.Do.pipe(
          Effect.bind("labels", () => loadDeskLabels),
          // Both time and eligibility can change during the provider read.
          Effect.bind("now", () => currentInstant),
          Effect.bind("rows", ({ now }) =>
            queryDuePasses(db, { ...input, now })
          ),
          Effect.map(({ rows: [row], labels }) =>
            Option.fromNullishOr(row && toCandidate(row, labels))
          )
        )
      );

      const readDue = Effect.fn("PassReminderReads.readDue")(
        (input: ReadDuePassReminder) =>
          queryDuePasses(db, input).pipe(
            Effect.flatMap(([row]) => {
              if (row?.deskId) return readWithDeskLabel(input);
              return Effect.succeed(
                Option.fromNullishOr(row && toCandidate(row))
              );
            })
          )
      );

      return PassReminderReads.of({ listDue, readDue });
    })
  );
}

const queryDuePasses = Effect.fn("PassReminderReads.queryDuePasses")(function* (
  db: WorkspaceDatabaseClient,
  input: ListDuePassReminders | ReadDuePassReminder
) {
  const { kind, dueDate, now } = input;
  const { lastUsableDate, validUntil } = getPassReminderEndDates(kind, dueDate);
  const today = getWorkspaceDate(now);
  const preview = !("passId" in input) && input.preview === true;
  if (
    Temporal.PlainDate.compare(today, validUntil) >= 0 ||
    (!preview &&
      Temporal.Instant.compare(now, getPassReminderDueAt(dueDate)) < 0)
  ) {
    return [];
  }

  const entriesLeft = sql<number | null>`(${passPurchases.entryCount} - (
      select count(*)::integer from ${passEntryClaims}
      where ${passEntryClaims.passId} = ${passPurchases.id}
        and ${ne(passEntryClaims.status, "released")}
    ))`;
  const assignedDesk = sql<DotyposTableId | null>`(
      select ${workspaceReservations.passDayTableId}
      from ${workspaceReservations}
      where ${workspaceReservations.passId} = ${passPurchases.id}
        and ${ne(passPurchases.tier, "open-space")}
      order by ${workspaceReservations.serviceDate}
      limit 1
    )`;
  const rows = yield* db
    .select({
      kind: passPurchases.product,
      passId: passPurchases.id,
      holderAccountId: passPurchases.holderAccountId,
      holderVersion: passPurchases.holderVersion,
      dotyposCustomerId: customerAccounts.dotyposCustomerId,
      tier: passPurchases.tier,
      validFrom: passPurchases.validFrom,
      packSize: passPurchases.entryCount,
      entriesLeft: kind === "entry-pack" ? entriesLeft : sql<null>`null`,
      deskId:
        kind === "unlimited" && "passId" in input && input.includeDeskLabel
          ? assignedDesk
          : sql<null>`null`,
    })
    .from(passPurchases)
    .innerJoin(orders, eq(orders.id, passPurchases.id))
    .innerJoin(
      customerAccounts,
      eq(customerAccounts.id, passPurchases.holderAccountId)
    )
    .where(
      and(
        eq(passPurchases.product, kind),
        eq(passPurchases.status, "active"),
        eq(passPurchases.validUntil, validUntil),
        isNull(passPurchases.accessEndsOn),
        isNotNull(customerAccounts.dotyposCustomerId),
        hasVerifiedActiveLogin(db, passPurchases.holderAccountId),
        eq(orders.kind, "pass-purchase"),
        or(
          and(eq(orders.paymentState, "paid"), isNotNull(orders.paidAt)),
          and(
            eq(orders.paymentState, "complimentary"),
            eq(orders.fulfillmentState, "fulfilled")
          )
        ),
        or(
          and(
            eq(passPurchases.buyerAccountId, passPurchases.holderAccountId),
            isNull(passPurchases.giftIssuedAt)
          ),
          and(isNotNull(passPurchases.giftClaimedAt), hasClaimablePassOrder(db))
        ),
        not(hasPendingPassChange(db, passPurchases.id)),
        kind === "entry-pack"
          ? gt(entriesLeft, 0)
          : and(
              not(hasUnlimitedRenewalOverlap),
              notExists(
                db
                  .select({ id: contractWithdrawals.id })
                  .from(contractWithdrawals)
                  .where(
                    and(
                      eq(contractWithdrawals.contractKind, "unlimited-pass"),
                      eq(contractWithdrawals.contractId, passPurchases.id)
                    )
                  )
              )
            ),
        "passId" in input
          ? and(
              eq(passPurchases.id, input.passId),
              eq(passPurchases.holderAccountId, input.holderAccountId),
              eq(passPurchases.holderVersion, input.holderVersion)
            )
          : input.afterPassId && gt(passPurchases.id, input.afterPassId)
      )
    )
    .orderBy(passPurchases.id)
    .limit("passId" in input ? 1 : passReminderPageSize);

  return rows.map((row) => ({ ...row, validUntil, lastUsableDate }));
});

const toCandidate = (
  {
    kind,
    entriesLeft,
    packSize,
    deskId,
    dotyposCustomerId,
    ...pass
  }: Effect.Success<ReturnType<typeof queryDuePasses>>[number],
  labels?: ReadonlyMap<DotyposTableId, string | undefined>
): PassReminderCandidate | undefined => {
  if (!dotyposCustomerId) return;
  if (kind === "entry-pack") {
    if (entriesLeft === null || packSize === null) return;
    return { ...pass, dotyposCustomerId, kind, entriesLeft, packSize };
  }
  const deskLabel = deskId ? labels?.get(deskId) : undefined;
  return {
    ...pass,
    dotyposCustomerId,
    kind,
    nextPeriodStart: pass.validUntil,
    ...(deskLabel && { deskLabel }),
  };
};
