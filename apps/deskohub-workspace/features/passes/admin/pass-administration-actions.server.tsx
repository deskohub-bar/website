import "server-only";

import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { connection } from "next/server";
import { cache } from "react";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  orders,
  passAdministrationChanges,
  passEntryClaims,
  passPurchases,
  paymentAttempts,
} from "@/db/schema";
import {
  formatAdministrationDateTime,
  formatAdministrationPlainDate,
} from "@/features/administration/formatters";
import { m } from "@/features/administration/i18n";
import { AdministrationAlert } from "@/features/administration/notice";
import {
  AdministrationRecordNotFound,
  runAdministrationPage,
} from "@/features/administrators/server/administration-request.server";
import type { Locale } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import { getWorkspaceDate } from "@/features/reservation/reservation-date";
import { currencyCZK } from "@/shared/money/currencies";
import { currentInstant, plainDateStringSchema } from "@/shared/utils/temporal";
import {
  CoworkPassesReleaseGate,
  CoworkPassesReleaseGateForRun,
} from "../backend/cowork-passes-release-gate";
import { GrantPassDialog, PassAdjustmentDialogs } from "./pass-action-dialogs";
import {
  getPassCancellationRefund,
  passValidityEnd,
  remainingPassRefundValue,
} from "./pass-adjustments";

const readPassActionData = Effect.fn("readPassActionData")(function* (
  passId: string
) {
  const gate = yield* CoworkPassesReleaseGate;
  if (!(yield* gate.isOpen)) return yield* new AdministrationRecordNotFound();
  const id = yield* Schema.decodeEffect(orderIdSchema)(passId).pipe(
    Effect.mapError(() => new AdministrationRecordNotFound())
  );
  const { db } = yield* WorkspaceDatabase;
  const [row, claims, audit, creditRecords] = yield* Effect.all(
    [
      db
        .select({
          pass: passPurchases,
          order: orders,
          attempt: {
            provider: paymentAttempts.provider,
            amount: paymentAttempts.amountValue,
            currency: paymentAttempts.currency,
            exponent: paymentAttempts.amountExponent,
            refunded: paymentAttempts.refundedAmountValue,
            target: paymentAttempts.refundTargetValue,
            state: paymentAttempts.refundState,
          },
        })
        .from(passPurchases)
        .innerJoin(orders, eq(orders.id, passPurchases.id))
        .leftJoin(
          paymentAttempts,
          and(
            eq(paymentAttempts.id, orders.activePaymentAttemptId),
            eq(paymentAttempts.state, "paid")
          )
        )
        .where(eq(passPurchases.id, id)),
      db
        .select({ date: passEntryClaims.date, status: passEntryClaims.status })
        .from(passEntryClaims)
        .where(
          and(
            eq(passEntryClaims.passId, id),
            ne(passEntryClaims.status, "released")
          )
        ),
      db
        .select({
          requestId: passAdministrationChanges.requestId,
          requestedAt: passAdministrationChanges.requestedAt,
          reason: passAdministrationChanges.reason,
          change: passAdministrationChanges.change,
          completedAt: passAdministrationChanges.completedAt,
          failedAt: passAdministrationChanges.failedAt,
          transferProgress: passAdministrationChanges.transferProgress,
        })
        .from(passAdministrationChanges)
        .where(eq(passAdministrationChanges.passId, id))
        .orderBy(
          desc(passAdministrationChanges.requestedAt),
          desc(passAdministrationChanges.requestId)
        )
        .limit(50),
      db
        .select({ change: passAdministrationChanges.change })
        .from(passAdministrationChanges)
        .where(
          and(
            eq(passAdministrationChanges.passId, id),
            sql`${passAdministrationChanges.change}->>'_tag' = 'validity' and (${passAdministrationChanges.change}->>'refundValue')::integer > 0`
          )
        ),
    ],
    { concurrency: "unbounded" }
  );
  const [details] = row;
  if (!details) return yield* new AdministrationRecordNotFound();
  const { pass, order, attempt } = details;
  const today = plainDateStringSchema.make(
    getWorkspaceDate(yield* currentInstant).toString()
  );
  const earliestLastDay = claims.reduce(
    (last, claim) => (claim.date > last ? claim.date : last),
    today > pass.validFrom ? today : pass.validFrom
  );
  const captured =
    attempt && attempt.currency === "CZK" && attempt.exponent === 2
      ? attempt
      : null;
  const payable =
    captured?.provider === "nexi" && order.paymentState === "paid"
      ? captured
      : null;
  const refundLimit = payable
    ? remainingPassRefundValue(
        payable.amount,
        payable.target ?? (payable.state === "required" ? payable.amount : 0),
        payable.refunded ?? 0
      )
    : 0;
  const paid = currencyCZK(payable?.amount ?? 0);
  let rawCancellationRefund = 0;
  if (pass.product === "unlimited") {
    rawCancellationRefund = getPassCancellationRefund({
      product: "unlimited",
      paid,
      validFrom: pass.validFrom,
      today,
    });
  } else if (pass.entryCount) {
    rawCancellationRefund = getPassCancellationRefund({
      product: "entry-pack",
      paid,
      today,
      entryCount: pass.entryCount,
      unusedEntries: Math.max(
        0,
        pass.entryCount - claims.filter(({ date }) => date <= today).length
      ),
    });
  }
  const refundCredits = creditRecords.flatMap(({ change }) =>
    change._tag === "validity" && change.refundValue > 0
      ? [
          {
            from: passValidityEnd(change.lastDay),
            until: change.expectedValidUntil,
            value: change.refundValue,
          },
        ]
      : []
  );
  const earlierAdjustments = refundCredits.reduce(
    (total, credit) => total + credit.value,
    0
  );
  const canAdjust =
    (pass.status === "active" ||
      (pass.product === "entry-pack" && pass.status === "depleted")) &&
    !audit.some((event) => !event.completedAt && !event.failedAt);
  return {
    audit,
    adjustment: canAdjust
      ? {
          passId: id,
          holderAccountId: pass.holderAccountId,
          holderVersion: pass.holderVersion,
          product: pass.product,
          validFrom: pass.validFrom,
          validUntil: pass.validUntil,
          earliestLastDay,
          today,
          paidValue: captured?.amount ?? null,
          complimentary: order.paymentState === "complimentary",
          refundable: payable !== null,
          refundLimit,
          refundCredits,
          cancellationRefund: Math.max(
            0,
            rawCancellationRefund - earlierAdjustments
          ),
          canReassign:
            pass.status === "active" &&
            (pass.product === "unlimited"
              ? today < pass.validFrom
              : claims.length === 0 && today < pass.validUntil),
        }
      : null,
  };
});

const loadPassActionData = cache((passId: string) =>
  runAdministrationPage(
    "administration.load-pass-actions",
    readPassActionData(passId),
    Layer.mergeAll(WorkspaceDatabase.Default, CoworkPassesReleaseGateForRun)
  )
);

export async function PassAdministrationActions({
  passId,
}: {
  readonly passId: string;
}) {
  const { adjustment } = await loadPassActionData(passId);
  return adjustment && <PassAdjustmentDialogs pass={adjustment} />;
}

export async function AdminGrantPass({
  initialEmail,
  initialName,
}: {
  readonly initialEmail?: string;
  readonly initialName?: string;
}) {
  await connection();
  return (
    <GrantPassDialog
      initialEmail={initialEmail}
      initialName={initialName}
      today={getWorkspaceDate(Temporal.Now.instant()).toString()}
    />
  );
}

export async function PassAdministrationAudit({
  passId,
  locale,
}: {
  readonly passId: string;
  readonly locale: Locale;
}) {
  const { audit } = await loadPassActionData(passId);
  const labels = {
    cancel: m.passActionsCancel,
    grant: m.passActionsGrant,
    reassign: m.passActionsReassign,
    validity: m.passActionsValidity,
  };
  if (!audit.length) return null;
  return (
    <section
      className="space-y-3 rounded-xl border p-4"
      aria-label={m.passActionsHistory({}, { locale })}
    >
      <h2 className="text-lg font-semibold">
        {m.passActionsHistory({}, { locale })}
      </h2>
      <ul className="divide-y">
        {audit.map((event) => (
          <li key={event.requestId} className="grid gap-1 py-2">
            <p className="font-medium">
              {labels[event.change._tag]({}, { locale })}
            </p>
            <p className="text-sm text-muted-foreground">
              {formatAdministrationDateTime(
                event.requestedAt.toString(),
                locale
              )}
            </p>
            <p className="break-words text-sm">{event.reason}</p>
            {!event.completedAt && (
              <AdministrationAlert
                status={event.failedAt ? "error" : "warning"}
              >
                {event.failedAt
                  ? m.passActionsFailed({}, { locale })
                  : m.passActionsPending({}, { locale })}
              </AdministrationAlert>
            )}
            {!!event.transferProgress?.conflicts.length && (
              <AdministrationAlert status="error">
                {m.passActionsTransferConflict(
                  {
                    dates: event.transferProgress.conflicts
                      .map((date) =>
                        formatAdministrationPlainDate(date, locale)
                      )
                      .join(", "),
                  },
                  { locale }
                )}
              </AdministrationAlert>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
