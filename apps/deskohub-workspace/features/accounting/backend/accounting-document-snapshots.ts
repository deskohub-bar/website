import type {
  DotyposCustomerId,
  DotyposReservationId,
} from "@deskohub/dotypos";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Context, Effect, Layer, Schema } from "effect";
import { WorkspaceTransaction } from "@/db/database.service";
import { accountingDocumentSnapshots } from "@/db/schema";
import {
  type AccountingDocumentSnapshot,
  accountingDocumentSnapshotSchema,
  encodeStoredAccountingDocumentSnapshot,
  type PassPurchaseAccountingSnapshot,
  passPurchaseAccountingSnapshotSchema,
} from "@/features/accounting/accounting-document-snapshot";
import type { PaymentAttemptId } from "@/features/checkout/checkout-identifiers";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { withPassPurchaseAddons } from "@/features/passes/pass-purchase-quote";
import { reservationOrderId } from "@/features/reservation/persistence-contracts";
import { type Money, moneyEquals, sameMoneyUnit } from "@/shared/money/money";
import {
  type AccountingRecordReference,
  AccountingRecordUnavailable,
  sealedAccountingJson,
} from "./sealed-accounting-json";

export type {
  AccountingRecordReference,
  AccountingRecordUnavailable,
} from "./sealed-accounting-json";

/** A snapshot accepted for a payment attempt that is about to be inserted. */
interface PreparedAccountingDocumentSnapshot {
  /** The snapshot as decoded strictly. */
  readonly snapshot: AccountingDocumentSnapshot;
  /**
   * Records the snapshot for the attempt the caller has just inserted, in
   * the caller's transaction: a failure rolls the attempt back with it. The
   * reservation's provider identity, read under the caller's locks, must be
   * the snapshot's, and an encryption key must be active. A caller that
   * returns an earlier attempt without recording needs no key.
   */
  readonly record: (attempt: {
    readonly paymentAttemptId: PaymentAttemptId;
    readonly dotyposCustomerId: DotyposCustomerId;
    readonly dotyposReservationId: DotyposReservationId | null;
  }) => Effect.Effect<void, AccountingRecordUnavailable, WorkspaceTransaction>;
}

export interface IAccountingDocumentSnapshots {
  readonly findPassPurchase: (
    paymentAttemptId: PaymentAttemptId
  ) => Effect.Effect<
    PassPurchaseAccountingSnapshot | null,
    AccountingRecordUnavailable | EffectDrizzleQueryError
  >;
  readonly recordPassPurchase: (input: {
    readonly snapshot: PassPurchaseAccountingSnapshot;
    readonly paymentAttemptId: PaymentAttemptId;
    readonly orderId: OrderId;
    readonly dotyposCustomerId: DotyposCustomerId;
    readonly locale: Locale;
    readonly amount: Money;
  }) => Effect.Effect<void, AccountingRecordUnavailable, WorkspaceTransaction>;
  /** The snapshot recorded for the attempt, or `null` when it has none. */
  readonly find: (
    paymentAttemptId: PaymentAttemptId
  ) => Effect.Effect<
    AccountingDocumentSnapshot | null,
    AccountingRecordUnavailable | EffectDrizzleQueryError
  >;
  /**
   * Accepts a snapshot for a payment attempt before the attempt's
   * transaction opens, so the payment can refuse before it writes anything:
   * the snapshot must decode strictly, belong to the attempt's reservation,
   * locale and amount, and reconcile its own money. `reference` names the
   * attempt in this and `record`'s errors until the attempt exists.
   */
  readonly prepare: (input: {
    readonly snapshot: AccountingDocumentSnapshot;
    readonly orderId: OrderId;
    readonly amount: Money;
    readonly locale: Locale;
    readonly reference: AccountingRecordReference;
  }) => Effect.Effect<
    PreparedAccountingDocumentSnapshot,
    AccountingRecordUnavailable
  >;
}

/**
 * Payment-time source snapshots, sealed one per payment attempt. Only the
 * accounting backend seals or opens them, through `AccountingDocumentSnapshots`.
 */
export const sealedAccountingDocumentSnapshots = sealedAccountingJson({
  label: "Accounting snapshot",
  table: accountingDocumentSnapshots,
  keyId: accountingDocumentSnapshots.keyId,
  ciphertext: accountingDocumentSnapshots.encryptedSnapshot,
  plaintext: {},
  encode: (snapshot: AccountingDocumentSnapshot) =>
    encodeStoredAccountingDocumentSnapshot(snapshot),
  schema: accountingDocumentSnapshotSchema,
});

const sealedEntryPackSnapshots = sealedAccountingJson({
  label: "Entry pack accounting snapshot",
  table: accountingDocumentSnapshots,
  keyId: accountingDocumentSnapshots.keyId,
  ciphertext: accountingDocumentSnapshots.encryptedSnapshot,
  plaintext: {},
  encode: Schema.encodeSync(passPurchaseAccountingSnapshotSchema),
  schema: passPurchaseAccountingSnapshotSchema,
});

/** The immutable source snapshot every payment attempt records. */
export class AccountingDocumentSnapshots extends Context.Service<
  AccountingDocumentSnapshots,
  IAccountingDocumentSnapshots
>()("@deskohub-workspace/accounting/AccountingDocumentSnapshots") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const snapshots = yield* sealedAccountingDocumentSnapshots;
      const entryPacks = yield* sealedEntryPackSnapshots;

      const find = Effect.fn("AccountingDocumentSnapshots.find")(function* (
        paymentAttemptId: PaymentAttemptId
      ) {
        const opened = yield* snapshots.open({
          reference: { type: "paymentAttemptId", id: paymentAttemptId },
          where: and(
            eq(accountingDocumentSnapshots.paymentAttemptId, paymentAttemptId),
            isNotNull(accountingDocumentSnapshots.workspaceReservationId)
          )!,
        });
        return opened?.value ?? null;
      });

      const findPassPurchase = Effect.fn(
        "AccountingDocumentSnapshots.findPassPurchase"
      )(function* (paymentAttemptId: PaymentAttemptId) {
        const opened = yield* entryPacks.open({
          reference: { type: "paymentAttemptId", id: paymentAttemptId },
          where: and(
            eq(accountingDocumentSnapshots.paymentAttemptId, paymentAttemptId),
            isNull(accountingDocumentSnapshots.workspaceReservationId)
          )!,
        });
        return opened?.value ?? null;
      });

      const recordPassPurchase = Effect.fn(
        "AccountingDocumentSnapshots.recordPassPurchase"
      )(function* (
        input: Parameters<IAccountingDocumentSnapshots["recordPassPurchase"]>[0]
      ) {
        const { db } = yield* WorkspaceTransaction;
        const reference = {
          type: "paymentAttemptId",
          id: input.paymentAttemptId,
        } satisfies AccountingRecordReference;
        const invalid = () =>
          new AccountingRecordUnavailable({
            operation: "validate",
            reference,
            message:
              "Pass purchase accounting snapshot does not match the payment attempt.",
          });
        const snapshot = yield* Schema.decodeUnknownEffect(
          Schema.toType(passPurchaseAccountingSnapshotSchema),
          { onExcessProperty: "error" }
        )(input.snapshot).pipe(Effect.mapError(invalid));
        if (
          snapshot.orderId !== input.orderId ||
          snapshot.dotyposCustomerId !== input.dotyposCustomerId ||
          snapshot.locale !== input.locale ||
          (snapshot.unlimitedCoffee &&
            (snapshot.product.kind !== "unlimited" ||
              snapshot.product.tier !== "open-space")) ||
          !moneyEquals(
            withPassPurchaseAddons(
              snapshot.quote.discountedSubtotal,
              snapshot.unlimitedCoffee
            ),
            input.amount
          )
        ) {
          return yield* invalid();
        }
        const sealer = yield* entryPacks.sealer(reference);
        yield* sealer.seal({
          reference,
          value: snapshot,
          insert: (sealed) =>
            db.insert(accountingDocumentSnapshots).values({
              paymentAttemptId: input.paymentAttemptId,
              keyId: sealed.keyId,
              encryptedSnapshot: sealed.ciphertext,
            }),
        });
      });

      const prepare = Effect.fn("AccountingDocumentSnapshots.prepare")(
        function* (input: {
          readonly snapshot: AccountingDocumentSnapshot;
          readonly orderId: OrderId;
          readonly amount: Money;
          readonly locale: Locale;
          readonly reference: AccountingRecordReference;
        }) {
          const snapshot = yield* acceptForAttempt(input);

          const record = Effect.fn("AccountingDocumentSnapshots.record")(
            function* (attempt: {
              readonly paymentAttemptId: PaymentAttemptId;
              readonly dotyposCustomerId: DotyposCustomerId;
              readonly dotyposReservationId: DotyposReservationId | null;
            }) {
              const { db } = yield* WorkspaceTransaction;

              if (
                snapshot.dotyposCustomerId !== attempt.dotyposCustomerId ||
                snapshot.dotyposReservationId !== attempt.dotyposReservationId
              ) {
                return yield* new AccountingRecordUnavailable({
                  operation: "validate",
                  reference: input.reference,
                  message:
                    "Accounting snapshot provider identity is inconsistent.",
                });
              }

              const sealer = yield* snapshots.sealer(input.reference);
              yield* sealer.seal({
                reference: {
                  type: "paymentAttemptId",
                  id: attempt.paymentAttemptId,
                },
                value: snapshot,
                insert: (sealed) =>
                  db.insert(accountingDocumentSnapshots).values({
                    paymentAttemptId: attempt.paymentAttemptId,
                    workspaceReservationId: snapshot.workspaceReservationId,
                    keyId: sealed.keyId,
                    encryptedSnapshot: sealed.ciphertext,
                  }),
              });
            }
          );

          const prepared: PreparedAccountingDocumentSnapshot = {
            snapshot,
            record,
          };
          return prepared;
        }
      );

      const service: IAccountingDocumentSnapshots = {
        find,
        prepare,
        findPassPurchase,
        recordPassPurchase,
      };
      return service;
    })
  );
}

const decodeAccountingDocumentSnapshot = Schema.decodeUnknownEffect(
  accountingDocumentSnapshotSchema,
  { onExcessProperty: "error" }
);

const acceptForAttempt = Effect.fnUntraced(function* (input: {
  readonly snapshot: AccountingDocumentSnapshot;
  readonly orderId: OrderId;
  readonly amount: Money;
  readonly locale: Locale;
  readonly reference: AccountingRecordReference;
}) {
  const snapshot = yield* decodeAccountingDocumentSnapshot(input.snapshot).pipe(
    Effect.mapError(
      () =>
        new AccountingRecordUnavailable({
          operation: "validate",
          reference: input.reference,
          message: "Accounting snapshot schema is invalid.",
        })
    )
  );

  if (
    reservationOrderId(snapshot.workspaceReservationId) !== input.orderId ||
    snapshot.locale !== input.locale ||
    !moneyEquals(snapshot.quote.payment.expectedPrice, input.amount) ||
    !moneyReconciles(snapshot)
  ) {
    return yield* new AccountingRecordUnavailable({
      operation: "validate",
      reference: input.reference,
      message: "Accounting snapshot does not match the payment attempt.",
    });
  }

  return snapshot;
});

/** Items sum to the undiscounted price, and less discounts to the payable one. */
const moneyReconciles = (snapshot: AccountingDocumentSnapshot): boolean => {
  const { items, payment } = snapshot.quote;
  const sameUnit = (amount: Money) =>
    sameMoneyUnit(amount, payment.expectedPrice);

  if (
    !sameUnit(payment.undiscountedPrice) ||
    !items.every(({ amount }) => sameUnit(amount)) ||
    !payment.discounts.every(
      ({ amount, subtotalAfter, subtotalBefore }) =>
        sameUnit(amount) && sameUnit(subtotalAfter) && sameUnit(subtotalBefore)
    )
  ) {
    return false;
  }

  const itemTotal = items.reduce((total, item) => total + item.amount.value, 0);
  const discountTotal = payment.discounts.reduce(
    (total, discount) => total + discount.amount.value,
    0
  );

  return (
    itemTotal === payment.undiscountedPrice.value &&
    itemTotal - discountTotal === payment.expectedPrice.value
  );
};
