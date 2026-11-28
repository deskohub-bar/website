"use client";

import { effectSchemaResolver } from "@deskohub/effect-schema-resolver";
import { Schema } from "effect";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { type Locale, m } from "@/features/i18n";
import type { addReservationInvitees } from "@/features/reservation/actions/add-reservation-invitees";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { reservationCustomerEmailSchema } from "@/features/reservation/reservation-contact";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";

const inviteeFormSchema = Schema.Struct({
  email: reservationCustomerEmailSchema,
});
const defaultValues = { email: "" };

export type AddCheckoutStatusInvitee = typeof addReservationInvitees;

export function CheckoutStatusAddInviteeForm({
  addInvitees,
  canAdd,
  locale,
  orderId,
}: {
  readonly addInvitees: AddCheckoutStatusInvitee;
  readonly canAdd: boolean;
  readonly locale: Locale;
  readonly orderId: WorkspaceReservationId;
}) {
  const router = useRouter();
  const emailId = useId();
  const errorId = useId();
  const [addedEmail, setAddedEmail] = useState<string>();
  const [isRefreshing, startRefresh] = useTransition();
  const {
    clearErrors,
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    reset,
    setError,
  } = useForm<
    typeof inviteeFormSchema.Encoded,
    unknown,
    typeof inviteeFormSchema.Type
  >({
    defaultValues,
    resolver: effectSchemaResolver(inviteeFormSchema),
  });
  const pending = isSubmitting || isRefreshing;
  const emailError =
    errors.email?.type === "duplicate"
      ? m.officePeopleDuplicateEmail({}, { locale })
      : errors.email && m.officePeopleInvalidEmail({}, { locale });

  const submit = handleSubmit(
    async ({ email }) => {
      setAddedEmail(undefined);
      const outcome = await addInvitees({ orderId, emails: [email] }).catch(
        () => ({ status: "failed" as const })
      );

      if (outcome.status === "added") {
        reset(defaultValues);
        setAddedEmail(email);
        startRefresh(() => router.refresh());
        return;
      }

      if (outcome.status === "failed") {
        setError("root.invitation", {
          message: m.checkoutStatusTableInviteeAddFailed({}, { locale }),
        });
        return;
      }

      if (
        outcome.reason === "invalid-email" ||
        outcome.reason === "duplicate"
      ) {
        setError("email", { type: outcome.reason }, { shouldFocus: true });
        return;
      }

      setError("root.invitation", {
        message:
          outcome.reason === "capacity"
            ? m.checkoutStatusTableInviteeCapacity({}, { locale })
            : m.checkoutStatusTableInviteeAddClosed({}, { locale }),
      });
    },
    () => setAddedEmail(undefined)
  );

  return (
    <>
      {canAdd && (
        <form
          aria-label={m.checkoutStatusTableInviteeAdd({}, { locale })}
          className="mt-4 space-y-2 border-t border-navy-blue/10 pt-4"
          noValidate
          onSubmit={submit}
        >
          <Label htmlFor={emailId}>
            {m.officePeopleEmailLabel({}, { locale })}
          </Label>
          <div className="flex flex-wrap items-start gap-2">
            <Input
              {...register("email", {
                onChange: () => {
                  clearErrors();
                  setAddedEmail(undefined);
                },
              })}
              aria-describedby={emailError ? errorId : undefined}
              aria-invalid={!!emailError}
              autoComplete="off"
              className="min-w-40 flex-1"
              data-ph-mask=""
              id={emailId}
              readOnly={pending}
              required
              type="email"
            />
            <Button
              disabled={pending}
              pending={pending}
              type="submit"
              variant="secondary"
            >
              {m.checkoutStatusTableInviteeAdd({}, { locale })}
            </Button>
          </div>
          <div
            className="text-sm text-burned-orange-ink"
            id={errorId}
            role="alert"
          >
            {emailError ?? errors.root?.invitation?.message}
          </div>
        </form>
      )}
      <div
        className="text-sm font-normal text-aquamarine-ink not-empty:mt-2"
        data-ph-mask=""
        role="status"
      >
        {addedEmail &&
          m.checkoutStatusTableInviteeAdded({ email: addedEmail }, { locale })}
      </div>
    </>
  );
}
