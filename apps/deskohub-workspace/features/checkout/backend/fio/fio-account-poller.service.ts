import { randomUUID } from "node:crypto";
import { Context, Data, Duration, Effect, Layer, Result } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import type { DatabaseQueryError } from "@/db/sql-constraint";
import { FioPaymentSettlementService } from "@/features/checkout/backend/payment/fio-payment-settlement.service";
import { QrPaymentRepository } from "@/features/checkout/backend/repositories/qr-payment.repository";
import { QueueRedelivery } from "@/shared/backend/queue/queue-consumer";
import {
  type QueueMessageSendError,
  QueuePublisher,
} from "@/shared/backend/queue/queue-publisher";
import { currentInstant } from "@/shared/utils";
import { FioAccountPollRepository } from "./fio-account-poll.repository";
import { FioAccounts, type FioReceivingAccount } from "./fio-accounts.service";
import { FioMovements } from "./fio-movements.service";
import {
  type FioPollJob,
  fioPollDeliveryExpiry,
  fioPollMaxWindowDays,
  publishFioPollJob,
} from "./fio-poll-wake.service";

const pollSpacingSeconds = 35;
// Keep the queue route's maxDuration in sync. Even a worker killed right at
// that limit leaves time for the token cooldown before another read can start.
const interruptedReadSpacingSeconds = 60 + pollSpacingSeconds;

class FioPollNotDue extends Data.TaggedError("FioPollNotDue")<{
  readonly instant: Temporal.Instant;
}> {}

class FioPollUnavailable extends Data.TaggedError("FioPollUnavailable")<{
  readonly reason:
    | "account_unconfigured"
    | "inaccessible_history"
    | "invalid_period"
    | "provider_rejected"
    | "provider_unavailable";
}> {}

type PollError =
  | DatabaseQueryError
  | QueueMessageSendError
  | FioPollNotDue
  | FioPollUnavailable
  | Effect.Error<
      ReturnType<FioPaymentSettlementService["Service"]["recordMovement"]>
    >;

interface IFioAccountPoller {
  readonly consume: (job: FioPollJob) => Effect.Effect<void, PollError>;
}

interface PollRead {
  readonly _tag: "Read";
  readonly readId: string;
  readonly receivingAccount: FioReceivingAccount;
  readonly from: string;
  readonly to: string;
  readonly today: string;
}

interface ReplayDispatch {
  readonly _tag: "ReplayDispatch";
  readonly readId: string | null;
}

export class FioAccountPoller extends Context.Service<
  FioAccountPoller,
  IFioAccountPoller
>()("FioAccountPoller") {
  static Default = Layer.effect(
    this,
    Effect.gen(function* () {
      const { transaction } = yield* WorkspaceDatabase;
      const polls = yield* FioAccountPollRepository;
      const accounts = yield* FioAccounts;
      const attempts = yield* QrPaymentRepository;
      const provider = yield* FioMovements;
      const settlements = yield* FioPaymentSettlementService;
      const publisher = yield* QueuePublisher;

      const claim = Effect.fn("FioAccountPoller.claim")(function* (
        job: FioPollJob,
        replayed?: ReplayDispatch
      ) {
        return yield* transaction(
          Effect.gen(function* () {
            const { accountKey, deliveryId } = job;
            const poll = yield* polls.lockDelivery(accountKey);
            if (poll?.deliveryId !== deliveryId) return;

            const payable = yield* attempts.hasPayableAttempts(accountKey);
            const now = yield* polls.currentTime(accountKey);
            if (
              (payable || poll.readId) &&
              poll.readNotBefore &&
              poll.readNotBefore.getTime() > now.epochMilliseconds
            ) {
              return yield* new FioPollNotDue({
                instant: Temporal.Instant.fromEpochMilliseconds(
                  poll.readNotBefore.getTime()
                ),
              });
            }

            // A prior read may still commit local dispatch work. The gate
            // above covers that read even if it already lost its last payable
            // attempt. Replay durable work before another read or retirement.
            if (!replayed && (!payable || poll.readId)) {
              return {
                _tag: "ReplayDispatch",
                readId: poll.readId,
              } satisfies ReplayDispatch;
            }
            if (replayed && replayed.readId !== poll.readId) {
              return yield* new FioPollNotDue({
                instant: now.add({ seconds: 1 }),
              });
            }
            if (!payable) {
              yield* polls.update(accountKey, idleDelivery);
              return;
            }

            const receivingAccount = accounts.getReceivingAccount(accountKey);
            if (!receivingAccount) {
              return yield* new FioPollUnavailable({
                reason: "account_unconfigured",
              });
            }

            const today = now
              .toZonedDateTimeISO("Europe/Prague")
              .toPlainDate()
              .toString();
            // An inclusive start on the last successful date replays the boundary
            // day. On the first read, retain the initial demand date across retries.
            const previous = poll.coveredThrough ?? poll.firstDemandDate;
            const from =
              poll.coveredThrough && job.advanceAfter === poll.coveredThrough
                ? addDays(previous, 1)
                : previous;
            if (from > today)
              return yield* new FioPollUnavailable({
                reason: "invalid_period",
              });
            const windowEnd = addDays(
              from,
              (job.windowDays ?? fioPollMaxWindowDays) - 1
            );
            const to = windowEnd < today ? windowEnd : today;

            const readId = randomUUID();
            yield* polls.update(accountKey, {
              readId,
              readNotBefore: new Date(
                now.add({ seconds: interruptedReadSpacingSeconds })
                  .epochMilliseconds
              ),
              deliveryExpiresAt: fioPollDeliveryExpiry(now),
            });
            return {
              _tag: "Read",
              readId,
              receivingAccount,
              from,
              to,
              today,
            } satisfies PollRead;
          })
        );
      });

      const finish = Effect.fn("FioAccountPoller.finish")(function* (
        job: FioPollJob,
        read: PollRead,
        outcome: "ingested" | "oversized"
      ) {
        yield* transaction(
          Effect.gen(function* () {
            const { accountKey } = job;
            const poll = yield* polls.lock(accountKey);
            if (
              poll?.deliveryId !== job.deliveryId ||
              poll.readId !== read.readId
            )
              return;

            const now = yield* polls.currentTime(accountKey);
            const nextWindow = continuation(job, read, outcome);
            const coverage = {
              coveredThrough:
                outcome === "ingested" ? read.to : poll.coveredThrough,
              readNotBefore: new Date(
                now.add({ seconds: pollSpacingSeconds }).epochMilliseconds
              ),
            };
            if (!nextWindow) {
              yield* Effect.logError(
                "Fio polling stopped because a one-day statement exceeds the read limit. Resolve the oversized statement before polling can cover this date."
              );
            }
            if (
              !nextWindow ||
              !(yield* attempts.hasPayableAttempts(accountKey))
            ) {
              yield* polls.update(accountKey, { ...coverage, ...idleDelivery });
              return;
            }

            const deliveryId = randomUUID();
            yield* polls.update(accountKey, {
              ...coverage,
              deliveryId,
              deliveryExpiresAt: fioPollDeliveryExpiry(now),
              readId: null,
            });
            yield* publishFioPollJob(
              { accountKey, deliveryId, ...nextWindow },
              Duration.seconds(pollSpacingSeconds)
            ).pipe(Effect.provideService(QueuePublisher, publisher));
          })
        );
      });

      return {
        consume: Effect.fn("FioAccountPoller.consume")(
          function* (job) {
            const candidate = yield* claim(job);
            if (candidate?._tag === "ReplayDispatch") {
              // Run replay outside the gate transaction. A failed replay
              // leaves the same delivery eligible for another attempt.
              yield* settlements.retryPendingDispatch(job.accountKey);
            }
            const read =
              candidate?._tag === "ReplayDispatch"
                ? yield* claim(job, candidate)
                : candidate;
            if (read?._tag !== "Read") return;

            const { account, readToken } = read.receivingAccount;
            const response = yield* provider
              .readPeriod({ account, readToken, from: read.from, to: read.to })
              .pipe(Effect.result);
            if (Result.isFailure(response)) {
              const error = response.failure;
              if (
                error._tag === "FioRejected" &&
                error.reason === "period-too-large"
              ) {
                yield* finish(job, read, "oversized");
                return;
              }
              return yield* new FioPollUnavailable({
                reason: providerFailureReasons[error._tag],
              });
            }
            const movements = response.success;
            const observedAt = yield* currentInstant;
            if (
              movements.some(
                ({ bookingDate }) =>
                  bookingDate < read.from || bookingDate > read.to
              )
            ) {
              return yield* new FioPollUnavailable({
                reason: "invalid_period",
              });
            }

            // A dispatch failure for one movement must not delay recording
            // the rest of this response with their original observation time.
            // Retain coverage until every movement effect has succeeded.
            const [, [ingestionFailure]] = yield* Effect.partition(
              movements,
              (movement) =>
                settlements.recordMovement({
                  accountKey: job.accountKey,
                  movementId: movement.movementId,
                  bookingDate: Temporal.PlainDate.from(movement.bookingDate),
                  observedAt,
                  amount: movement.amount,
                  ...(movement.reference._tag === "VariableSymbol"
                    ? { variableSymbol: movement.reference.value }
                    : {
                        variableSymbol: null,
                        referenceStatus:
                          movement.reference._tag === "Absent"
                            ? ("absent" as const)
                            : ("invalid" as const),
                      }),
                })
            );
            if (ingestionFailure) return yield* Effect.fail(ingestionFailure);
            yield* finish(job, read, "ingested");
          },
          Effect.tapError((error) =>
            error._tag === "FioPollUnavailable"
              ? Effect.logWarning(pollFailureMessages[error.reason])
              : Effect.void
          )
        ),
      };
    })
  );
}

const idleDelivery = {
  deliveryId: null,
  deliveryExpiresAt: null,
  readId: null,
};

const addDays = (date: string, days: number) =>
  Temporal.PlainDate.from(date).add({ days }).toString();

const continuation = (
  job: FioPollJob,
  { from, to, today }: PollRead,
  outcome: "ingested" | "oversized"
): Pick<FioPollJob, "windowDays" | "advanceAfter"> | undefined => {
  if (outcome === "oversized") {
    const days = Temporal.PlainDate.from(from).until(to).days + 1;
    return days > 1 ? { windowDays: Math.floor(days / 2) } : undefined;
  }
  if (to === today) return {};
  // With a one-day limit, first replay the boundary day. Once it has been
  // fully ingested, the successor reads the contiguous next day to make progress.
  if (job.windowDays === 1) return { windowDays: 1, advanceAfter: to };
  return job.windowDays ? { windowDays: job.windowDays } : {};
};

const providerFailureReasons = {
  FioHistoryAccessRequired: "inaccessible_history",
  FioRejected: "provider_rejected",
  FioUnavailable: "provider_unavailable",
} as const;

const pollFailureMessages = {
  account_unconfigured:
    "Fio poll could not resolve its receiving account. Check Workspace FIO_RECEIVING_ACCOUNTS configuration.",
  inaccessible_history:
    "Fio poll cannot access its checkpoint range. Authorize historical account access in Fio and let the active poll retry.",
  invalid_period:
    "Fio poll received an inconsistent booking-date range. Check the provider response and the account checkpoint.",
  provider_rejected:
    "Fio rejected the polling request. Check the receiving account and read token configuration.",
  provider_unavailable:
    "Fio polling request failed. The queue will retry while payable demand remains.",
} as const;

export const fioPollRedelivery = (error: PollError): QueueRedelivery =>
  error._tag === "FioPollNotDue"
    ? QueueRedelivery.At({ instant: error.instant })
    : QueueRedelivery.WithBackoff();
