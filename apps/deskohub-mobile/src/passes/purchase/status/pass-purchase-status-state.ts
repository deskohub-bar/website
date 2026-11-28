import {
  type CustomerLocale,
  type CustomerPassPurchaseStatus,
  CustomerSessionRequired,
} from "@deskohub/workspace-customer-api";
import {
  type Cause,
  Duration,
  Effect,
  Option,
  Queue,
  Result,
  Stream,
} from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import {
  AccountReadBudget,
  allowsAutomaticRefresh,
} from "../../../customer-api/account-read-budget";
import { AccountExitFence } from "../../../customer-api/account-scoped-storage";
import {
  CustomerAccountScope,
  CustomerApi,
} from "../../../customer-api/customer-api.service";
import { customerDataRuntime } from "../../../customer-api/customer-data-runtime";
import { customerRead } from "../../../customer-api/customer-request";
import { appForegroundAtom } from "../../../platform/app-foreground";

/** Read only in the account session that owns the screen, including on return. */
export const readPassPurchaseStatus = Effect.fn("readPassPurchaseStatus")(
  function* (orderId: string, locale: CustomerLocale) {
    const scope = yield* CustomerAccountScope;
    const fence = yield* AccountExitFence;
    const api = yield* CustomerApi;
    if (!(yield* fence.isCurrent(scope))) {
      return yield* new CustomerSessionRequired();
    }
    const outcome = yield* api.passes
      .getPassPurchaseStatus({ params: { orderId }, query: { locale } })
      .pipe(customerRead({ accountRead: true }), Effect.result);
    if (!(yield* fence.isCurrent(scope))) {
      return yield* new CustomerSessionRequired();
    }
    return yield* Effect.fromResult(outcome);
  }
);

// Space out settlement reads and keep the account budget available for taps.
const pollDelays = [3, 3, 5, 5, 10, 15, 20, 30, 60] as const;

type StatusReadFailure = Effect.Error<
  ReturnType<typeof readPassPurchaseStatus>
>;
type StatusRead = Result.Result<CustomerPassPurchaseStatus, StatusReadFailure>;

interface StatusProgress {
  readonly refresh: number;
  readonly attempts: number;
  readonly reading: "manual" | "automatic" | false;
  readonly polling: boolean;
  readonly unconfirmed: boolean;
  readonly outcome?: StatusRead | undefined;
  readonly confirmed?: CustomerPassPurchaseStatus | undefined;
}

const canKeepConfirmed = (failure: StatusReadFailure) =>
  failure._tag === "CustomerRateLimited" ||
  failure._tag === "CustomerServiceUnavailable" ||
  failure._tag === "CustomerRequestTimedOut" ||
  (failure._tag === "HttpClientError" &&
    (failure.reason._tag === "TransportError" ||
      (failure.reason._tag === "StatusCodeError" &&
        failure.reason.response.status >= 500)));

const lostPurchaseAccess = (failure: StatusReadFailure) =>
  failure._tag === "CustomerSessionRequired" ||
  failure._tag === "CustomerPassNotFound" ||
  failure._tag === "CustomerAccountLinkRequired" ||
  failure._tag === "CustomerPassesUnavailable";

export type PassPurchaseStatusCheck =
  | "manual"
  | "after-payment"
  | "unconfirmed";

interface StatusRefresh {
  readonly revision: number;
  readonly kind: PassPurchaseStatusCheck;
}

const statusUpdates = (
  read: ReturnType<typeof readPassPurchaseStatus>,
  refresh: number,
  start: StatusProgress
) =>
  Stream.callback((queue: Queue.Queue<StatusProgress, Cause.Done>) =>
    Effect.gen(function* () {
      const budget = yield* AccountReadBudget;
      let state = start;
      const readOnce = (reading: "manual" | "automatic") =>
        Effect.gen(function* () {
          state = {
            ...state,
            refresh,
            reading,
            outcome: undefined,
            attempts: state.attempts + (reading === "automatic" ? 1 : 0),
          };
          yield* Queue.offer(queue, state);
          const outcome = yield* Effect.result(read);
          const fresh = Result.isSuccess(outcome) ? outcome.success : undefined;
          const retain =
            Result.isFailure(outcome) && canKeepConfirmed(outcome.failure);
          const settling =
            fresh?.status === "pending" || fresh?.status === "checking";
          // A failed read cannot resolve a payment. Only an explicit
          // loss of access makes it inappropriate to keep the warning.
          const unresolved = Result.isFailure(outcome)
            ? !lostPurchaseAccess(outcome.failure)
            : settling || fresh?.status === "not_started";
          state = {
            ...state,
            outcome,
            confirmed: fresh ?? (retain ? state.confirmed : undefined),
            reading: false,
            polling: state.polling && settling,
            unconfirmed: state.unconfirmed && unresolved,
          };
          yield* Queue.offer(queue, state);
        });

      if (state.refresh !== refresh || (!state.outcome && !state.confirmed)) {
        yield* readOnce("manual");
      } else {
        // An interrupted refresh already spent its dispatch. Recover the
        // first read, but wait for a new tap before repeating a manual read.
        state = { ...state, reading: false };
        yield* Queue.offer(queue, state);
      }

      for (const seconds of pollDelays.slice(state.attempts)) {
        if (!state.polling || !allowsAutomaticRefresh(yield* budget.remaining))
          break;
        yield* Effect.sleep(Duration.seconds(seconds));
        if (!allowsAutomaticRefresh(yield* budget.remaining)) break;
        yield* readOnce("automatic");
      }

      yield* Queue.offer(queue, { ...state, polling: false });
    })
  );

/**
 * Each mounted visit has its own refresh count. Going offscreen interrupts
 * its timer or request, preserving the count and answer for when it resumes.
 */
export const makePassPurchaseStatusAtoms = (
  orderId: string,
  locale: CustomerLocale,
  afterPayment: boolean,
  foreground = appForegroundAtom
) => {
  const focused = Atom.make(false);
  const refresh = Atom.make<StatusRefresh>({
    revision: 0,
    kind: afterPayment ? "after-payment" : "manual",
  });
  const status = customerDataRuntime.atom((get) => {
    const active = get(focused) && get(foreground);
    const request = get(refresh);
    if (!active) return Stream.never;

    const previous = Option.flatMap(
      get.self<AsyncResult.AsyncResult<StatusProgress, never>>(),
      AsyncResult.value
    );
    let start = Option.getOrElse(
      previous,
      (): StatusProgress => ({
        refresh: request.revision,
        attempts: 0,
        reading: false,
        polling: request.kind !== "manual",
        unconfirmed: request.kind === "unconfirmed",
      })
    );
    if (request.kind !== "manual" && start.refresh !== request.revision) {
      start = {
        ...start,
        attempts: 0,
        polling: true,
        unconfirmed: start.unconfirmed || request.kind === "unconfirmed",
      };
    }
    return statusUpdates(
      readPassPurchaseStatus(orderId, locale),
      request.revision,
      start
    );
  });

  return { focused, refresh, status };
};
