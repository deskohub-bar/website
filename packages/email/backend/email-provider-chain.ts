import { createHash } from "node:crypto";
import { Array as Arr, Effect, Ref, Result } from "effect";
import type {
  EmailBatchResult,
  EmailMessage,
  EmailSendResult,
} from "../types/email.types";
import { entriesAtBatchPositions } from "./batch-positions";
import {
  continuesEmailChain,
  type EmailBatchOptions,
  type EmailProvider,
  type EmailSendError,
} from "./capabilities";
import {
  type EmailDeliveryObserver,
  observeEmailDelivery,
} from "./email-delivery-observer";
import { type EmailStream, emailCategoryOf } from "./email-providers";
import { NetworkError } from "./network-error";

/** What a chain reports deliveries to. */
export interface EmailChainContext {
  readonly streamOf: (message: EmailMessage) => EmailStream;
  readonly observer: EmailDeliveryObserver;
}

/** Provider logs receive fixed codes and tags, never raw error messages. */
export const emailFailureLogFacts = (error: EmailSendError) => ({
  code:
    error._tag === "NetworkError"
      ? "email.send.transport-retryable"
      : "email.send.rejected",
  errorType: error._tag,
  errorCode: error.code,
  failureKind: error.failureKind,
});

const reportSent = (
  context: EmailChainContext,
  message: EmailMessage,
  result: EmailSendResult
) =>
  observeEmailDelivery(() =>
    context.observer.onSent({
      provider: result.provider,
      deliveryId: result.id,
      stream: context.streamOf(message),
      category: emailCategoryOf(message),
      tags: message.tags ?? [],
      metadata: message.metadata,
      idempotencyKey: message.idempotencyKey,
      at: new Date(),
    })
  );

const reportFallback = (
  context: EmailChainContext,
  message: EmailMessage,
  failed: EmailProvider,
  next: EmailProvider,
  error: EmailSendError
) =>
  observeEmailDelivery(() =>
    context.observer.onFallback({
      stream: context.streamOf(message),
      category: emailCategoryOf(message),
      failedProvider: failed.name,
      nextProvider: next.name,
      errorKind: error._tag,
      errorCode: error.code,
      at: new Date(),
    })
  );

/**
 * Sends one message through the chain: each provider tries it in turn while
 * the previous one failed at the provider level. Fails with the error that
 * ended the chain.
 */
export const sendThroughChain = (
  chain: ReadonlyArray<EmailProvider>,
  message: EmailMessage,
  context: EmailChainContext
): Effect.Effect<EmailSendResult, EmailSendError> =>
  Arr.matchLeft(chain, {
    onEmpty: () =>
      Effect.die(new RangeError("An email provider chain has no provider")),
    onNonEmpty: (provider, fallbacks) =>
      sendFromProvider(provider, fallbacks, message, context),
  }).pipe(Effect.tap((result) => reportSent(context, message, result)));

/** Sends `message` through `provider`, then each of `fallbacks` in turn. */
const sendFromProvider = (
  provider: EmailProvider,
  fallbacks: ReadonlyArray<EmailProvider>,
  message: EmailMessage,
  context: EmailChainContext
): Effect.Effect<EmailSendResult, EmailSendError> =>
  provider.send(message).pipe(
    Effect.catch((error) => {
      const [next, ...later] = fallbacks;
      return next && continuesEmailChain(error)
        ? Effect.logWarning("Email provider failed; trying the next one", {
            ...emailFailureLogFacts(error),
            provider: provider.name,
            nextProvider: next.name,
          }).pipe(
            Effect.andThen(
              reportFallback(context, message, provider, next, error)
            ),
            Effect.andThen(sendFromProvider(next, later, message, context))
          )
        : Effect.fail(error);
    })
  );

/** A batch message still to send, by its place in the caller's batch. */
interface PendingBatchMessage {
  readonly index: number;
  readonly message: EmailMessage;
}

/**
 * The key a later provider sends a fallback subset under: the caller's key
 * for the whole batch, else one derived from the provider's place in the
 * chain and the subset, so a replay of the same subset reuses it.
 */
const fallbackIdempotencyKey = (
  options: EmailBatchOptions,
  providerIndex: number,
  indices: readonly number[],
  batchSize: number
) =>
  indices.length === batchSize
    ? options.idempotencyKey
    : `${options.idempotencyKey}:fallback:${createHash("sha256")
        .update(`${providerIndex}:${indices.join(",")}`)
        .digest("hex")
        .slice(0, 16)}`;

const unmatchedBatchAnswer = (provider: EmailProvider) =>
  new NetworkError({
    message: `${provider.name} answered a batch with a different number of results`,
    code: "batch-size-mismatch",
    failureKind: "unknown-outcome",
  });

/** A provider's batch answer, refused when it doesn't answer every message. */
const checkedBatchAnswer = (
  provider: EmailProvider,
  outcome: Result.Result<readonly EmailBatchResult[], EmailSendError>,
  size: number
): Result.Result<readonly EmailBatchResult[], EmailSendError> =>
  Result.isFailure(outcome) || outcome.success.length === size
    ? outcome
    : Result.fail(unmatchedBatchAnswer(provider));

/**
 * The messages an admission error denies, when it validly names some but not
 * all of the request, so that each resend is strictly smaller.
 */
const partlyDeniedMessages = (
  error: EmailSendError,
  requested: readonly number[]
) => {
  if (error._tag !== "EmailServiceError" || !error.deniedPositions) return;
  const { deniedPositions } = error;
  const denied = new Set(
    deniedPositions.map((position) => requested[position])
  );
  const valid =
    !denied.has(undefined) &&
    denied.size === deniedPositions.length &&
    denied.size > 0 &&
    denied.size < requested.length;
  return valid ? denied : undefined;
};

/**
 * Sends a batch through the chain. The first provider gets every message
 * under the caller's key; each later provider gets the messages its
 * predecessor failed at the provider level. Results follow the message
 * order. The call fails as a whole only when the first provider failed the
 * whole batch and the chain ends there, as a single provider's batch always
 * did; once a message fell through, every failure comes back per message,
 * so a caller's replay of the batch never repeats a fallback that may have
 * delivered. A fallback request partly denied before dispatch continues
 * without the denied messages (`allowFallbackWithAdmission`). A replay
 * (`options.replay`) tries only the first provider.
 */
export const sendBatchThroughChain = Effect.fn("email.sendBatchThroughChain")(
  function* (
    chain: ReadonlyArray<EmailProvider>,
    messages: readonly EmailMessage[],
    options: EmailBatchOptions,
    context: EmailChainContext
  ) {
    const results: EmailBatchResult[] = [];
    let pending: readonly PendingBatchMessage[] = messages.map(
      (message, index) => ({ index, message })
    );

    const singleProvider =
      options.replay ||
      (options.beforeRequest && !options.allowFallbackWithAdmission);
    const providers = singleProvider ? chain.slice(0, 1) : chain;
    const { beforeRequest, allowFallbackWithAdmission } = options;
    let providerIndex = 0;
    while (pending.length > 0) {
      const provider = providers[providerIndex];
      if (provider === undefined) break;
      const next = providers[providerIndex + 1];
      const pendingIndices = pending.map(({ index }) => index);
      const admitted = yield* Ref.make(false);
      const requested = yield* Ref.make<readonly number[]>([]);
      const outcome = yield* Effect.result(
        provider.sendBatch(
          pending.map(({ message }) => message),
          {
            ...(beforeRequest && {
              beforeRequest: (fingerprint, positions) =>
                entriesAtBatchPositions(pendingIndices, positions).pipe(
                  Effect.tap((indices) => Ref.set(requested, indices)),
                  Effect.flatMap((indices) =>
                    beforeRequest(fingerprint, indices)
                  ),
                  Effect.andThen(Ref.set(admitted, true))
                ),
            }),
            ...(!singleProvider &&
              allowFallbackWithAdmission && {
                allowFallbackWithAdmission,
              }),
            idempotencyKey: fallbackIdempotencyKey(
              options,
              providerIndex,
              pendingIndices,
              messages.length
            ),
          }
        )
      );
      const answer = checkedBatchAnswer(provider, outcome, pending.length);

      if (Result.isFailure(answer)) {
        yield* Effect.logWarning("Email provider failed the batch", {
          ...emailFailureLogFacts(answer.failure),
          provider: provider.name,
          size: pending.length,
        });
        if (
          providerIndex === 0 &&
          (!next || !continuesEmailChain(answer.failure))
        ) {
          return yield* answer.failure;
        }
        // Once a request was admitted it may have left, so nothing is repacked.
        if (providerIndex > 0 && !(yield* Ref.get(admitted))) {
          const denied = partlyDeniedMessages(
            answer.failure,
            yield* Ref.get(requested)
          );
          if (denied) {
            const timestamp = new Date();
            for (const { index } of pending) {
              if (!denied.has(index)) continue;
              results[index] = {
                status: "failed",
                provider: provider.name,
                timestamp,
                error: answer.failure,
              };
            }
            pending = pending.filter(({ index }) => !denied.has(index));
            continue;
          }
        }
      }

      const timestamp = new Date();
      const answered: readonly EmailBatchResult[] = Result.isSuccess(answer)
        ? answer.success
        : pending.map(
            (): EmailBatchResult => ({
              status: "failed",
              provider: provider.name,
              timestamp,
              error: answer.failure,
            })
          );

      const fallingThrough: PendingBatchMessage[] = [];
      for (const [entry, result] of Arr.zip(pending, answered)) {
        const { index, message } = entry;
        results[index] = result;
        if (result.status !== "failed") {
          yield* reportSent(context, message, result);
        } else if (next && continuesEmailChain(result.error)) {
          fallingThrough.push(entry);
          yield* reportFallback(context, message, provider, next, result.error);
        }
      }
      if (next && fallingThrough.length > 0) {
        yield* Effect.logWarning(
          "Email batch messages move to the next provider",
          {
            provider: provider.name,
            nextProvider: next.name,
            size: fallingThrough.length,
          }
        );
      }
      pending = fallingThrough;
      providerIndex++;
    }

    return results;
  }
);
