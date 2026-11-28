"use server";

import { eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { WorkspaceDatabaseAdvisoryLock } from "@/db/postgres-advisory-lock";
import { passPurchases } from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import {
  ensurePassHolderAccount,
  findPassHolderAccount,
} from "@/features/account/backend/customer-account-by-email";
import { administrationHref } from "@/features/administration/administration-href";
import { m } from "@/features/administration/i18n";
import { ReservationAdministrationService } from "@/features/administration/reservation-administration.service";
import { defineAdministrationAction } from "@/features/administrators/server/administration-request.server";
import { orderIdSchema } from "@/features/order";
import { GoogleCalendarWorkspaceLimitationsService } from "@/features/reservation/backend/google-calendar-workspace-limitations.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import {
  CoworkPassesReleaseGate,
  CoworkPassesReleaseGateForRun,
} from "../backend/cowork-passes-release-gate";
import { resolvePassHolderCustomer } from "../backend/unlimited-pass-purchase";
import { applyPackAdjustment } from "./apply-pass-adjustment";
import { beginUnlimitedPassChange } from "./begin-unlimited-pass-change";
import { completePassChange } from "./complete-pass-change";
import { grantPass } from "./grant-pass";
import { passActionInputSchema } from "./pass-action-input";
import { PassChangeRefused } from "./pass-change-records";

const action = defineAdministrationAction(
  {
    operation: "administration.change-pass",
    schema: Schema.toStandardSchemaV1(passActionInputSchema),
    logInput: false,
    failureCopy: {
      timeout: m.administrationActionTimedOut,
      unexpected: m.administrationActionFailedUnexpectedly,
    },
    capabilities: Layer.mergeAll(
      CoworkPassesReleaseGateForRun,
      WorkspaceDatabase.Default,
      WorkspaceDatabaseAdvisoryLock.Default,
      WorkspaceDotyposLayer,
      GoogleCalendarWorkspaceLimitationsService.Live,
      WorkspaceReservationRepository.Live,
      ReservationAdministrationService.Live
    ),
    revalidates: ({ requestId, change }) => [
      administrationHref("/[locale]/admin/passes"),
      administrationHref("/[locale]/admin/passes/[passId]", {
        passId: change._tag === "grant" ? requestId : change.passId,
      }),
    ],
    publicFailure: (cause, locale) => {
      if (!(cause instanceof PassChangeRefused))
        return m.passActionsUnavailable({}, { locale });
      switch (cause.reason) {
        case "invalid-validity":
          return m.passActionsInvalidValidity({}, { locale });
        case "refund-limit":
          return m.passActionsRefundLimit({}, { locale });
        case "first-use":
          return m.passActionsFirstUse({}, { locale });
        case "pending-claims":
          return m.passActionsPendingClaims({}, { locale });
        case "pending-change":
          return m.passActionsPendingChange({}, { locale });
        case "holder-unavailable":
          return m.passActionsHolderUnavailable({}, { locale });
        case "capacity":
          return m.passActionsCapacity({}, { locale });
        case "successor-present":
          return m.passActionsSuccessorPresent({}, { locale });
        default:
          return m.passActionsChanged({}, { locale });
      }
    },
  },
  Effect.fn(function* ({ requestId, reason, change }, { locale }) {
    const gate = yield* CoworkPassesReleaseGate;
    if (!(yield* gate.isOpen))
      return yield* new PassChangeRefused({ reason: "not-found" });
    const { db, transaction } = yield* WorkspaceDatabase;
    const resolveHolder = Effect.fnUntraced(function* (email: string) {
      const holder =
        (yield* findPassHolderAccount(email)) ??
        (yield* transaction(ensurePassHolderAccount(email)));
      if (!holder)
        return yield* new PassChangeRefused({ reason: "holder-unavailable" });
      return holder;
    });
    const record = yield* Effect.gen(function* () {
      if (change._tag === "grant") {
        return yield* grantPass(
          {
            requestId,
            reason,
            passId: orderIdSchema.make(requestId),
            change: {
              _tag: "grant",
              selection: change.selection,
              holderAccountId: yield* resolveHolder(change.email),
            },
          },
          locale,
          change.recipientName
        );
      }
      const [pass] = yield* db
        .select({ product: passPurchases.product })
        .from(passPurchases)
        .where(eq(passPurchases.id, change.passId));
      if (!pass) return yield* new PassChangeRefused({ reason: "not-found" });
      if (change._tag === "reassign") {
        const holderAccountId = yield* resolveHolder(change.email);
        const holderCustomerId =
          pass.product === "unlimited"
            ? yield* resolvePassHolderCustomer({
                accountId: holderAccountId,
                email: change.email,
                recipientName: change.recipientName,
              }).pipe(
                WorkspaceLockSections.unlimitedGiftCustomer(holderAccountId)
              )
            : undefined;
        const input = {
          requestId,
          reason,
          passId: change.passId,
          change: {
            _tag: "reassign" as const,
            expectedHolderAccountId: change.expectedHolderAccountId,
            expectedHolderVersion: change.expectedHolderVersion,
            holderAccountId,
            ...(holderCustomerId && { holderCustomerId }),
          },
        };
        return pass.product === "unlimited"
          ? yield* beginUnlimitedPassChange(input)
          : yield* applyPackAdjustment(input);
      }
      const input = { requestId, reason, passId: change.passId, change };
      return pass.product === "unlimited"
        ? yield* beginUnlimitedPassChange(input)
        : yield* applyPackAdjustment(input);
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "UnlimitedPassCapacityUnavailable"
          ? new PassChangeRefused({ reason: "capacity" })
          : error
      )
    );
    const result =
      record.completedAt || record.failedAt
        ? record
        : yield* completePassChange(record).pipe(
            Effect.timeout("16 seconds"),
            Effect.orElseSucceed(() => record)
          );
    const passId = result.passId;
    if (result.completedAt) return { passId, status: "completed" as const };
    if (result.failedAt) return { passId, status: "failed" as const };
    return { passId, status: "pending" as const };
  })
);

export const submitPassAction: typeof action = async (...args) => {
  return await action(...args);
};
