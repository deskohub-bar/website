import "server-only";

import { Effect, Layer, Option } from "effect";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { requireVerifiedSession } from "@/features/account/backend/verified-customer-session";
import type { Locale } from "@/features/i18n";
import type { OrderId } from "@/features/order";
import { CoworkPassesReleaseGate } from "@/features/passes/backend/cowork-passes-release-gate";
import { CoworkPassesReleaseGateRequest } from "@/features/passes/backend/cowork-passes-release-gate.server";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import type { WithdrawableContractRef } from "@/features/withdrawal/withdrawable-contract";
import type { ContractWithdrawalEntry } from "@/features/withdrawal/withdrawal-read-model";
import { WithdrawalRepository } from "./withdrawal.repository";
import { WithdrawalService } from "./withdrawal.service";
import { WithdrawalReleaseGate } from "./withdrawal-release-gate";
import { WithdrawalReleaseGateRequest } from "./withdrawal-release-gate.server";

/**
 * Whether the signed-in customer can withdraw from this reservation now: the
 * same quote the confirm step shows, offered only while the function is
 * released. Anything that keeps the quote from being made (signed out, not
 * the author, period over, a failed read) hides the entry point.
 */
const isWithdrawalOffered = Effect.fn("withdrawal.entry.offered")(
  function* (input: {
    readonly contract: WithdrawableContractRef;
    readonly locale: Locale;
  }) {
    if (!(yield* WithdrawalReleaseGate.isOpen)) return false;
    if (
      input.contract.kind !== "reservation" &&
      !(yield* CoworkPassesReleaseGate.isOpen.pipe(
        Effect.provide(CoworkPassesReleaseGateRequest)
      ))
    ) {
      return false;
    }
    const user = yield* requireVerifiedSession;
    const withdrawals = yield* WithdrawalService;
    yield* withdrawals.quote({
      accountId: user.accountId,
      locale: input.locale,
      contract: input.contract,
    });
    return true;
  },
  (effect) =>
    effect.pipe(
      Effect.catchCause(() => Effect.succeed(false)),
      Effect.provide(
        Layer.mergeAll(
          WithdrawalService.Live,
          CustomerAuthentication.Default,
          WithdrawalReleaseGateRequest
        )
      )
    )
);

/**
 * A recorded withdrawal survives the release decision. A failed read shows
 * no withdrawal.
 */
const findRecordedWithdrawal = Effect.fn("withdrawal.entry.recorded")(
  function* (contract: WithdrawableContractRef) {
    const repository = yield* WithdrawalRepository;
    return yield* repository.findByContract(contract);
  },
  (effect) =>
    effect.pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Recorded withdrawal could not be read").pipe(
          Effect.as(Option.none())
        )
      ),
      Effect.provide(WithdrawalRepository.Live)
    )
);

/**
 * Reads the reservation's withdrawal entry for its status page. The recorded
 * withdrawal and the offer are read side by side, so the page waits for the
 * slower of the two only; a recorded withdrawal wins.
 */
export const readReservationWithdrawalEntry = ({
  reservationId,
  locale,
}: {
  readonly reservationId: WorkspaceReservationId;
  readonly locale: Locale;
}) => {
  const contract = { kind: "reservation", id: reservationId } as const;
  return Effect.all(
    [
      findRecordedWithdrawal(contract),
      isWithdrawalOffered({ contract, locale }),
    ],
    { concurrency: "unbounded" }
  ).pipe(
    Effect.map(
      ([recorded, offered]): ContractWithdrawalEntry =>
        Option.match(recorded, {
          onSome: ({ refundAmount }) => ({ status: "withdrawn", refundAmount }),
          onNone: () => (offered ? { status: "offered" } : { status: "none" }),
        })
    ),
    Effect.withSpan("withdrawal.entry.read")
  );
};

/** Called by the buyer's pass status page, after it authorizes the order. */
export const readPassWithdrawalEntry = Effect.fn("withdrawal.entry.pass")(
  function* (input: {
    readonly contract: {
      readonly kind: "entry-pack" | "unlimited-pass";
      readonly id: OrderId;
    };
    readonly locale: Locale;
    readonly offerWithdrawal: boolean;
  }) {
    const recorded = yield* findRecordedWithdrawal(input.contract);
    if (Option.isSome(recorded)) {
      const user = yield* requireVerifiedSession;
      return recorded.value.accountId === user.accountId
        ? ({
            status: "withdrawn",
            refundAmount: recorded.value.refundAmount,
          } as const)
        : ({ status: "none" } as const);
    }

    if (input.offerWithdrawal && (yield* isWithdrawalOffered(input)))
      return { status: "offered" } as const;
    return { status: "none" } as const;
  },
  (effect) =>
    effect.pipe(
      Effect.provide(CustomerAuthentication.Default),
      Effect.catchCause(() => Effect.succeed({ status: "none" } as const))
    )
);
