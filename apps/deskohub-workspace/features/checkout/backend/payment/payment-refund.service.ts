import "@/shared/polyfills/temporal";

import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
} from "effect";
import type { SqlError } from "effect/sql";
import { WorkspaceDatabase } from "@/db/database.service";
import { databasePoolTimeouts } from "@/db/database-pool-timeouts";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { parseInstant } from "@/shared/utils/temporal";
import {
  type ClaimedRefundCheck,
  type PaymentRefundRecordResult,
  PaymentRefundRepository,
  type RefundablePaymentAttempt,
  type ReservationRefundAttempt,
} from "../repositories/payment-refund.repository";
import { PaymentProviders } from "./payment-provider";
import { PaymentProvidersLive } from "./payment-providers";

/**
 * `no_refund` means the provider reports no successful refund for the order
 * yet; the other results come from recording the refund.
 */
type PaymentRefundReconciliationResult =
  | PaymentRefundRecordResult
  | "no_refund";

interface PaymentRefundReconciliationSummary {
  readonly checked: number;
  readonly recorded: number;
  readonly failed: number;
}

export class PaymentRefundReconciliationError extends Data.TaggedError(
  "PaymentRefundReconciliationError"
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface IPaymentRefundService {
  /**
   * Reads the provider order and records any successful refund on the
   * attempt. The provider's order operations establish that money went back.
   */
  readonly reconcileAttempt: (
    input: RefundablePaymentAttempt
  ) => Effect.Effect<
    PaymentRefundReconciliationResult,
    PaymentRefundReconciliationError
  >;
  /**
   * Reconciles, one after another, each of the reservation's provider attempts
   * still awaiting a refund (`reconcileAttempt`), then returns all its
   * payment attempts as stored. Run these provider calls outside every
   * database transaction.
   */
  readonly reconcileReservationRefunds: (
    reservationId: WorkspaceReservationId
  ) => Effect.Effect<
    readonly ReservationRefundAttempt[],
    PaymentRefundReconciliationError
  >;
  /**
   * Reconciles up to `limit` attempts still awaiting a refund and recent
   * payments the provider has not fully refunded, least recently checked first,
   * skipping any checked in the last few hours. Each attempt is claimed just
   * before its lookup, and the lookup starts only while one taking
   * `worstCaseLookupDuration` still ends within `budget`; a claim that leaves
   * too little time is released. At `budget` the batch interrupts whatever is
   * still claiming, looking up, or recording, and releases those claims, each
   * release waiting at most `claimReleaseTimeout`. Attempts the batch did not
   * check therefore stay due for the next run, except a claim whose COMMIT is
   * in flight at the budget: it stays stamped until the recheck interval
   * passes. The batch returns within `budget` plus
   * `refundBatchOverrunWorstCase`. One attempt's provider failure is logged
   * and does not stop the rest of the batch.
   */
  readonly reconcileRefunds: (input: {
    readonly limit: number;
    readonly budget: Duration.Input;
    readonly worstCaseLookupDuration: Duration.Input;
  }) => Effect.Effect<
    PaymentRefundReconciliationSummary,
    EffectDrizzleQueryError | SqlError.SqlError
  >;
}

/**
 * How long after creating a paid attempt that nobody marked for refund the
 * batch checks providers for back-office refunds, including any remaining
 * amount after a partial refund. Production has received no Nexi notification for
 * back-office refunds, so unless one arrives, an older payment's refund is
 * recorded only once an operator cancellation marks it as required.
 */
const unrequestedRefundCheckWindow = Temporal.Duration.from({
  hours: 30 * 24,
});

/**
 * How long the batch waits before checking the same attempt again, so a
 * quiet period does not re-read every eligible order on every run.
 */
const refundRecheckInterval = Temporal.Duration.from({ hours: 6 });

const lookupConcurrency = 4;

/**
 * How long releasing an unchecked claim may take. A release that has not
 * finished by then is abandoned, so that attempt waits out the recheck
 * interval instead of the batch outrunning its function deadline.
 */
const claimReleaseTimeout = Duration.seconds(10);

/**
 * The longest `reconcileRefunds` can run past its budget. At the budget it
 * interrupts every worker, but Effect SQL acquires a transaction's
 * connection, runs BEGIN, and commits or rolls back uninterruptibly, each
 * bounded by the pool's timeouts. A claim interrupted while acquiring its
 * connection therefore still acquires it, begins, and rolls back. Every
 * other tail is shorter: an in-flight COMMIT or the rollback of an
 * interrupted statement takes one query timeout, and releasing an
 * interrupted claim takes at most `claimReleaseTimeout`.
 */
export const refundBatchOverrunWorstCase = Duration.millis(
  Math.max(
    databasePoolTimeouts.connectionTimeoutMillis +
      2 * databasePoolTimeouts.query_timeout,
    Duration.toMillis(claimReleaseTimeout)
  )
);

/**
 * The provider's latest refund time, or the recording time when it omits it or
 * reports a time that names no instant. The refund itself is still recorded.
 */
const toRefundedAt = (value: string | undefined, fallback: Temporal.Instant) =>
  Option.fromNullishOr(value).pipe(
    Option.flatMap(parseInstant),
    Option.getOrElse(() => fallback)
  );

export class PaymentRefundService extends Context.Service<
  PaymentRefundService,
  IPaymentRefundService
>()("@deskohub-workspace/checkout/PaymentRefundService") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const providers = yield* PaymentProviders;
      const refunds = yield* PaymentRefundRepository;

      const reconcileAttempt = Effect.fn(
        "PaymentRefundService.reconcileAttempt"
      )(
        function* ({ attempt, correlationId }: RefundablePaymentAttempt) {
          const { refund } = yield* providers
            .forAttempt(attempt.provider)
            .lookup({
              providerOrderId: attempt.providerOrderId,
              correlationId,
            });
          if (!refund) {
            yield* Effect.logInfo("Provider reports no successful refund yet");
            return "no_refund" as const;
          }
          yield* Effect.annotateLogsScoped({
            refundAmount: refund.amount,
            refundOperationCount: refund.operationIds.length,
            ...(refund.lastRefundedAt && {
              lastRefundedAt: refund.lastRefundedAt,
            }),
          });

          const recordedAt = Temporal.Now.instant();
          const result = yield* refunds.recordRefund({
            id: attempt.id,
            refundedAmountValue: refund.amount,
            refundedAt: toRefundedAt(refund.lastRefundedAt, recordedAt),
            recordedAt,
          });
          yield* Effect.annotateLogsScoped({ result });
          // The operation ids go on the result row only, not every row.
          const withRefundOperations = Effect.annotateLogs({
            refundOperationIds: refund.operationIds.join(","),
          });
          if (result === "not_applicable") {
            yield* Effect.logWarning(
              "Provider refund found for an attempt that cannot record it"
            ).pipe(withRefundOperations);
          } else if (result === "below_target") {
            yield* Effect.logInfo(
              "Provider refund is still below the refund owed"
            ).pipe(withRefundOperations);
          } else {
            yield* Effect.logInfo("Provider refund reconciled").pipe(
              withRefundOperations
            );
          }
          return result;
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new PaymentRefundReconciliationError({
                  message: "Payment refund reconciliation failed.",
                  cause,
                })
            ),
            Effect.scoped,
            Effect.annotateLogs({
              paymentAttemptId: input.attempt.id,
              paymentProvider: input.attempt.provider,
              providerOrderId: input.attempt.providerOrderId,
            })
          )
      );

      const reconcileReservationRefunds = Effect.fn(
        "PaymentRefundService.reconcileReservationRefunds"
      )(
        function* (reservationId: WorkspaceReservationId) {
          const required = yield* refunds.findRequiredRefunds(reservationId);
          yield* Effect.forEach(required, reconcileAttempt, { discard: true });
          return yield* refunds.findReservationAttempts(reservationId);
        },
        (effect, reservationId) =>
          effect.pipe(
            Effect.mapError((cause) =>
              cause instanceof PaymentRefundReconciliationError
                ? cause
                : new PaymentRefundReconciliationError({
                    message: "Reservation refund reconciliation failed.",
                    cause,
                  })
            ),
            Effect.annotateLogs({ reservationId })
          )
      );

      const reconcileRefunds = Effect.fn(
        "PaymentRefundService.reconcileRefunds"
      )(function* (input: {
        readonly limit: number;
        readonly budget: Duration.Input;
        readonly worstCaseLookupDuration: Duration.Input;
      }) {
        const startedAt = yield* Clock.currentTimeMillis;
        // A lookup started later than this could outlast the budget.
        const lastLookupStart =
          startedAt +
          Duration.toMillis(input.budget) -
          Duration.toMillis(input.worstCaseLookupDuration);
        const lookupFits = Effect.map(
          Clock.currentTimeMillis,
          (now) => now <= lastLookupStart
        );
        let unclaimed = input.limit;
        let exhausted = false;
        const results: (PaymentRefundReconciliationResult | "failed")[] = [];

        const claimNext = Effect.gen(function* () {
          const checkedAt = Temporal.Instant.fromEpochMilliseconds(
            Math.floor(yield* Clock.currentTimeMillis)
          );
          const [claimed] = yield* refunds.claimRefundChecks({
            providers: providers.activeProviders,
            limit: 1,
            checkedAt,
            lastCheckedBefore: checkedAt.subtract(refundRecheckInterval),
            recentPaymentsSince: checkedAt.subtract(
              unrequestedRefundCheckWindow
            ),
          });
          return claimed;
        });

        const releaseClaim = (claimed: ClaimedRefundCheck) =>
          refunds
            .releaseRefundCheck({ ...claimed, id: claimed.attempt.id })
            .pipe(
              // Release runs as a finalizer; let the timeout cut it short.
              Effect.interruptible,
              Effect.timeout(claimReleaseTimeout),
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "Unchecked refund claim was not released; it waits for the recheck interval",
                  { cause, paymentAttemptId: claimed.attempt.id }
                )
              )
            );

        // Claims one attempt and checks it. Unless the check completes, the
        // claim is released: the budget ran out while claiming, or the batch
        // deadline interrupted the lookup or the recording of its refund. An
        // interrupted claim rolls back, so it leaves nothing to release.
        /** Checks a claimed attempt; `false` when it was not checked. */
        const checkClaimed = Effect.fn(function* (
          claimed: ClaimedRefundCheck | undefined
        ) {
          if (!claimed) {
            exhausted = true;
            return false;
          }
          if (!(yield* lookupFits)) return false;
          results.push(
            yield* reconcileAttempt(claimed).pipe(
              Effect.tapError((cause) =>
                Effect.logError("Payment refund reconciliation failed", {
                  cause,
                })
              ),
              Effect.orElseSucceed(() => "failed" as const)
            )
          );
          return true;
        });

        const checkNext = Effect.acquireUseRelease(
          Effect.interruptible(claimNext),
          checkClaimed,
          (claimed, exit) =>
            claimed && !(Exit.isSuccess(exit) && exit.value)
              ? releaseClaim(claimed)
              : Effect.void
        );

        const worker = Effect.gen(function* () {
          while (unclaimed > 0 && !exhausted && (yield* lookupFits)) {
            unclaimed -= 1;
            if (!(yield* checkNext) && !exhausted) return;
          }
        });

        const finishedInTime = yield* Effect.all(
          Array.from({ length: lookupConcurrency }, () => worker),
          { concurrency: "unbounded", discard: true }
        ).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({
            duration: Duration.millis(
              Math.max(
                0,
                startedAt +
                  Duration.toMillis(input.budget) -
                  (yield* Clock.currentTimeMillis)
              )
            ),
            orElse: () => Effect.succeed(false),
          })
        );
        if (!finishedInTime || (unclaimed > 0 && !exhausted)) {
          yield* Effect.logWarning(
            "Payment refund reconciliation stopped at its time budget",
            { unclaimed }
          );
        }
        const summary: PaymentRefundReconciliationSummary = {
          checked: results.length,
          recorded: results.filter((result) => result === "recorded").length,
          failed: results.filter((result) => result === "failed").length,
        };
        yield* Effect.logInfo("Payment refund reconciliation batch completed", {
          summary,
        });
        return summary;
      });

      return PaymentRefundService.of({
        reconcileAttempt,
        reconcileReservationRefunds,
        reconcileRefunds,
      });
    })
  );

  static Live = this.Default.pipe(
    Layer.provide(PaymentRefundRepository.Default),
    Layer.provide(WorkspaceDatabase.Default),
    Layer.provide(PaymentProvidersLive)
  );
}
