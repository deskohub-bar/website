"use server";

import { Effect, Layer, Schema } from "effect";
import { readReservationAccessCookie } from "@/features/reservation/backend/reservation-access-cookie";
import { ReservationAuthorizationService } from "@/features/reservation/backend/reservation-authorization.service";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import {
  addAuthorizedReservationInvitees,
  addReservationInviteesServices,
  type InvitationAddRefused,
} from "@/features/reservation-invitees/backend/add-reservation-invitees";
import { getRequestCookies } from "@/shared/backend/utils/request-cookies";
import { defineWorkspaceAction } from "@/shared/backend/workspace-action";

type AddInviteesOutcome =
  | { readonly status: "added"; readonly added: number }
  | {
      readonly status: "refused";
      readonly reason: InvitationAddRefused["refusal"]["reason"];
    }
  | { readonly status: "failed" };

const add = defineWorkspaceAction(
  {
    operation: "reservation.add-invitees",
    logInput: false,
    schema: Schema.toStandardSchemaV1(
      Schema.Struct({
        orderId: workspaceReservationIdSchema,
        emails: Schema.NonEmptyArray(Schema.String),
      })
    ),
  },
  Effect.fnUntraced(
    function* ({ orderId, emails }, { locale }) {
      const cookies = yield* getRequestCookies;
      return yield* addAuthorizedReservationInvitees({
        orderId,
        emails,
        locale,
        accessCookie: readReservationAccessCookie(cookies, orderId),
      });
    },
    (result) =>
      result.pipe(
        Effect.provide(
          Layer.mergeAll(
            addReservationInviteesServices,
            ReservationAuthorizationService.Live
          )
        ),
        Effect.map(
          ({ added }): AddInviteesOutcome => ({ status: "added", added })
        ),
        Effect.catchTag("InvitationAddRefused", ({ refusal }) =>
          Effect.succeed<AddInviteesOutcome>({
            status: "refused",
            reason: refusal.reason,
          })
        ),
        Effect.catch(() =>
          Effect.logWarning("Reservation invitee addition failed", {
            code: "reservation.invitation.add-failed",
          }).pipe(Effect.as<AddInviteesOutcome>({ status: "failed" }))
        )
      )
  )
);

export const addReservationInvitees = async (
  input: Parameters<typeof add>[0]
): Promise<AddInviteesOutcome> => {
  const result = await add(input);
  return result?.data ?? { status: "failed" };
};
