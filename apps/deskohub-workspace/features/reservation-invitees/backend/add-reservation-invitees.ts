import { Data, Effect, Layer, Option, Result } from "effect";
import { WorkspaceDatabase, WorkspaceTransaction } from "@/db/database.service";
import { reservationInviteeNotices } from "@/db/schema";
import { WorkspaceLockSections } from "@/db/workspace-locks";
import type { Locale } from "@/features/i18n";
import {
  checkInviteeEmail,
  type InviteeEmail,
} from "@/features/office/office-people";
import { ReservationAuthorizationService } from "@/features/reservation/backend/reservation-authorization.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { WorkspaceReservationService } from "@/features/reservation/backend/workspace-reservation.service";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { WithdrawalRepository } from "@/features/withdrawal/backend/withdrawal.repository";
import { currentInstant } from "@/shared/utils/temporal";
import { resendReservationInvitationServices } from "./resend-reservation-invitation";
import { ReservationInviteeEmailKeys } from "./reservation-invitee-email-keys.service";
import { ReservationInviteeNoticeWorker } from "./reservation-invitee-notice-worker";
import {
  ReservationInvitees,
  recordOfficeInvitees,
  sealOfficePeople,
} from "./reservation-invitees.service";

type InvitationAddRefusal = {
  readonly reason:
    | "not-found"
    | "not-confirmed"
    | "ended"
    | "invalid-email"
    | "duplicate"
    | "capacity";
};

export class InvitationAddRefused extends Data.TaggedError(
  "InvitationAddRefused"
)<{ readonly refusal: InvitationAddRefusal }> {}

const refuse = (reason: InvitationAddRefusal["reason"]) =>
  new InvitationAddRefused({ refusal: { reason } });

export const addReservationInviteesServices = Layer.mergeAll(
  resendReservationInvitationServices,
  WorkspaceDatabase.Default,
  ReservationInviteeEmailKeys.Default
);

export const addAuthorizedReservationInvitees = Effect.fnUntraced(
  function* (input: {
    readonly orderId: WorkspaceReservationId;
    readonly locale: Locale;
    readonly emails: readonly string[];
    readonly accessCookie?: string;
  }) {
    const { orderId, locale, emails, accessCookie } = input;
    const authorization = yield* ReservationAuthorizationService;
    if (
      !(yield* authorization.authorize({
        orderId,
        locale,
        accessCookie,
        permission: "add-invitees",
      }))
    ) {
      return yield* refuse("not-found");
    }

    const noticeIds = yield* WorkspaceLockSections.reservationInviteeNotices(
      orderId
    )(
      Effect.gen(function* () {
        const reservations = yield* WorkspaceReservationRepository;
        const stored = yield* reservations.findById(orderId);
        if (stored?.reservationDetails.kind !== "table") {
          return yield* refuse("not-found");
        }
        const contactAttends = stored.officeContactAttends;
        if (
          stored.paymentState !== "paid" ||
          stored.reservationState !== "confirmed" ||
          contactAttends === null
        ) {
          return yield* refuse("not-confirmed");
        }
        const withdrawals = yield* WithdrawalRepository;
        const withdrawal = yield* withdrawals.findByContract({
          kind: "reservation",
          id: orderId,
        });
        if (Option.isSome(withdrawal)) return yield* refuse("not-confirmed");

        const workspace = yield* WorkspaceReservationService;
        const reservation = yield* workspace
          .getReservation(orderId)
          .pipe(Effect.timeout("8 seconds"));
        if (reservation.providerStatus !== "CONFIRMED") {
          return yield* refuse("not-confirmed");
        }

        const guests = yield* ReservationInvitees;
        const existing = yield* guests.listForReservation(orderId);
        if (emails.length === 0) return yield* refuse("invalid-email");
        if (
          Number(contactAttends) + existing.length + emails.length >
          reservation.seats
        ) {
          return yield* refuse("capacity");
        }

        const known = existing.flatMap(({ email }) =>
          email === null ? [] : [email]
        );
        const additions: InviteeEmail[] = [];
        for (const candidate of emails) {
          const checked = checkInviteeEmail(candidate, {
            invitees: known,
            contactEmail: reservation.customer.email ?? undefined,
          });
          if (Result.isFailure(checked)) {
            return yield* refuse(
              checked.failure === "invalid" ? "invalid-email" : "duplicate"
            );
          }
          known.push(checked.success);
          additions.push(checked.success);
        }

        const occurredAt = yield* currentInstant;
        if (
          Temporal.Instant.compare(occurredAt, reservation.reservedUntil) >= 0
        ) {
          return yield* refuse("ended");
        }
        const sealed = yield* sealOfficePeople(
          {
            contactAttends,
            invitees: additions,
          },
          reservation.reservedUntil
        );
        const firstPosition = (existing.at(-1)?.position ?? -1) + 1;
        const { transaction } = yield* WorkspaceDatabase;

        // The same lock serializes appends and booking transition notices.
        // Commit the new recipients and only their notices together.
        return yield* transaction(
          Effect.gen(function* () {
            const { db } = yield* WorkspaceTransaction;
            const inserted = yield* recordOfficeInvitees(
              orderId,
              sealed,
              firstPosition
            );
            const notices = yield* db
              .insert(reservationInviteeNotices)
              .values(
                inserted.map<typeof reservationInviteeNotices.$inferInsert>(
                  ({ id }) => ({
                    inviteeId: id,
                    kind: "invitation",
                    occurredAt,
                    nextAttemptAt: occurredAt,
                  })
                )
              )
              .returning({ id: reservationInviteeNotices.id });
            return notices.map(({ id }) => id);
          })
        );
      })
    );

    const notices = yield* ReservationInviteeNoticeWorker;
    yield* notices.dispatchAddedInvitations(orderId, noticeIds);
    return { added: noticeIds.length };
  }
);
