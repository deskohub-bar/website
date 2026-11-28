"use client";

import {
  resendCooldownSecondsAtom,
  SIGN_IN_EMAIL_RESEND_COOLDOWN_MS,
} from "@deskohub/workspace-customer-api/sign-in-email";
import { useAtomValue } from "@effect/atom-react";
import {
  createOTPInputController,
  OTPInput,
  OTPInputGroup,
  OTPInputSeparator,
  OTPInputSlot,
} from "@ui-sdk/react/otp-input";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Fragment, type RefObject, useRef, useState } from "react";
import type {
  SignInCodeVerification,
  SignInEmailFailure,
} from "@/features/account/auth-return";
import { signInEmailFailureMessage } from "@/features/account/components/sign-in-email-failure-message";
import { SIGN_IN_CODE_LENGTH } from "@/features/account/email-sign-in-request";
import { type Locale, m } from "@/features/i18n";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/utils";

type CodeStatus = "idle" | SignInCodeVerification | "verifying";
type ResendStatus = "idle" | "sending" | "sent" | SignInEmailFailure;

type SignInCodeStepProps = {
  readonly locale: Locale;
  /** When the email holding the current code was requested (epoch ms). */
  readonly requestedAt: number;
  readonly verifiedMessage: string;
  readonly verifyCode: (code: string) => Promise<SignInCodeVerification>;
  readonly onVerified: () => void;
  /**
   * Sends a new email and reports whether it went out, or that a cancel or a
   * newer request replaced it.
   */
  readonly requestNewEmail: () => Promise<
    "sent" | "cancelled" | SignInEmailFailure
  >;
  readonly onUseDifferentEmail?: () => void;
};

const isDeadCode = (status: CodeStatus) =>
  status === "expired" || status === "too-many-attempts";

/**
 * Code entry shared by sign-in and account-deletion re-authentication. The
 * caller renders the heading and the masked-address description.
 */
export function SignInCodeStep({
  locale,
  requestedAt,
  verifiedMessage,
  verifyCode,
  onVerified,
  requestNewEmail,
  onUseDifferentEmail,
}: SignInCodeStepProps) {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<CodeStatus>("idle");
  const [resendStatus, setResendStatus] = useState<ResendStatus>("idle");
  const [shownRequestedAt, setShownRequestedAt] = useState(requestedAt);
  const [codeInput] = useState(createOTPInputController);
  const codeFieldRef = useRef<HTMLDivElement>(null);
  const resendRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const cooldownSeconds = useAtomValue(
    resendCooldownSecondsAtom(requestedAt + SIGN_IN_EMAIL_RESEND_COOLDOWN_MS)
  );

  // A new email replaces the code: start the entry over.
  if (shownRequestedAt !== requestedAt) {
    setShownRequestedAt(requestedAt);
    setCode("");
    setStatus("idle");
  }

  const submitCode = async (value: string) => {
    // The disabled input keeps no focus ring while the code is checked.
    codeFieldRef.current?.querySelector("input")?.blur();
    setStatus("verifying");
    setResendStatus("idle");
    const verification = await verifyCode(value);
    setStatus(verification);
    if (verification === "verified") {
      onVerified();
      return;
    }
    setCode("");
    // Move focus once the controls re-enable: back into the input for another
    // try, or to the way out when this code can no longer work.
    requestAnimationFrame(() => {
      if (!isDeadCode(verification)) codeInput.focus();
      else if (resendRef.current?.disabled === false) resendRef.current.focus();
      else statusRef.current?.focus();
    });
  };

  const sendNewEmail = async () => {
    setResendStatus("sending");
    const outcome = await requestNewEmail();
    setResendStatus(outcome === "cancelled" ? "idle" : outcome);
    if (outcome === "sent") codeInput.focus();
  };

  const dead = isDeadCode(status);
  const verifying = status === "verifying";
  const verified = status === "verified";
  // While a code is checked or after it worked, nothing else may start.
  const settling = verifying || verified;
  const invalid = status === "wrong";
  const { message: statusMessage, tone: statusTone } = codeStepStatus({
    locale,
    resendStatus,
    status,
    verifiedMessage,
  });

  return (
    <div className="mt-8">
      <label
        htmlFor="account-sign-in-code"
        className="text-sm font-semibold text-navy-blue"
      >
        {m.accountSignInCodeLabel({}, { locale })}
      </label>
      <OTPInput
        ref={codeFieldRef}
        controller={codeInput}
        id="account-sign-in-code"
        autoFocus
        maxLength={SIGN_IN_CODE_LENGTH}
        value={code}
        onValueChange={setCode}
        onValueCommit={submitCode}
        onPasteCapture={(event) => {
          const input = event.target;
          if (!(input instanceof HTMLInputElement) || input.disabled) return;
          // A code copied from the email can include the surrounding text.
          event.preventDefault();
          event.stopPropagation();
          const digits = event.clipboardData
            .getData("text/plain")
            .replace(/\D/g, "");
          const start = input.selectionStart ?? code.length;
          const end = input.selectionEnd ?? start;
          codeInput.setValue(code.slice(0, start) + digits + code.slice(end), {
            reason: "paste",
            event: event.nativeEvent,
          });
        }}
        disabled={dead || settling}
        aria-invalid={invalid}
        aria-describedby="account-sign-in-code-status"
        className="mt-2 flex w-full max-w-[22rem] items-center gap-2 data-disabled:opacity-50 sm:gap-3"
      >
        {[
          [0, 1, 2],
          [3, 4, 5],
        ].map((group, index) => (
          <Fragment key={group[0]}>
            {index > 0 && (
              <OTPInputSeparator className="h-0.5 w-3 shrink-0 rounded-full bg-navy-blue/30" />
            )}
            <OTPInputGroup className="flex flex-1 items-center gap-1.5 sm:gap-2">
              {group.map((slot) => (
                <OTPInputSlot
                  key={slot}
                  index={slot}
                  className={cn(
                    "relative flex h-14 w-full items-center justify-center rounded-xl border bg-white text-2xl font-semibold tabular-nums text-navy-blue transition data-active:z-10 data-active:border-burned-orange data-active:ring-2 data-active:ring-burned-orange/70 data-[fake-caret]:after:h-6 data-[fake-caret]:after:w-px data-[fake-caret]:after:animate-caret-blink data-[fake-caret]:after:bg-navy-blue",
                    invalid ? "border-red-700/70" : "border-navy-blue/45"
                  )}
                />
              ))}
            </OTPInputGroup>
          </Fragment>
        ))}
      </OTPInput>

      <div
        ref={statusRef}
        id="account-sign-in-code-status"
        aria-live="polite"
        tabIndex={-1}
        className={cn(
          "mt-3 flex min-h-5 items-start gap-2 text-sm leading-5 outline-none",
          {
            neutral: "text-navy-blue/68",
            success: "text-aquamarine-ink",
            error: "text-red-700",
          }[statusTone]
        )}
      >
        {verifying && (
          <Loader2
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 animate-spin"
          />
        )}
        {verified && (
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        )}
        {statusMessage}
      </div>

      <CodeStepEmailControls
        cooldownSeconds={cooldownSeconds}
        dead={dead}
        locale={locale}
        onResend={sendNewEmail}
        onUseDifferentEmail={onUseDifferentEmail}
        resendRef={resendRef}
        resendStatus={resendStatus}
        settling={settling}
      />

      <p className="mt-6 border-t border-navy-blue/10 pt-5 text-sm leading-6 text-navy-blue/60">
        {m.accountSignInCodeLinkHint({}, { locale })}
      </p>
    </div>
  );
}

// A rejected resend outranks the earlier code result so it is seen and
// announced; checking another code clears it.
function codeStepStatus({
  locale,
  resendStatus,
  status,
  verifiedMessage,
}: {
  readonly locale: Locale;
  readonly resendStatus: ResendStatus;
  readonly status: CodeStatus;
  readonly verifiedMessage: string;
}): {
  readonly message: string | null;
  readonly tone: "neutral" | "success" | "error";
} {
  if (
    resendStatus !== "idle" &&
    resendStatus !== "sending" &&
    resendStatus !== "sent"
  ) {
    return {
      message: signInEmailFailureMessage(resendStatus, locale),
      tone: "error",
    };
  }
  return {
    message: {
      idle:
        resendStatus === "sent"
          ? m.accountSignInCodeResent({}, { locale })
          : null,
      verifying: m.accountSignInCodeVerifying({}, { locale }),
      verified: verifiedMessage,
      wrong: m.accountSignInCodeInvalid({}, { locale }),
      expired: m.accountSignInCodeExpired({}, { locale }),
      "too-many-attempts": m.accountSignInCodeTooManyAttempts({}, { locale }),
      automated: m.accountSignInAutomatedRequest({}, { locale }),
      failed: m.accountSignInCodeFailed({}, { locale }),
    }[status],
    tone: (
      {
        idle: "neutral",
        verifying: "neutral",
        verified: "success",
        wrong: "error",
        expired: "error",
        "too-many-attempts": "error",
        automated: "error",
        failed: "error",
      } as const
    )[status],
  };
}

/**
 * The ways on from a code: a new email once the cooldown is over (the main
 * action once the code is dead), and changing the address where offered.
 */
function CodeStepEmailControls({
  cooldownSeconds,
  dead,
  locale,
  onResend,
  onUseDifferentEmail,
  resendRef,
  resendStatus,
  settling,
}: {
  readonly cooldownSeconds: number;
  readonly dead: boolean;
  readonly locale: Locale;
  readonly onResend: () => void;
  readonly onUseDifferentEmail: (() => void) | undefined;
  readonly resendRef: RefObject<HTMLButtonElement | null>;
  readonly resendStatus: ResendStatus;
  readonly settling: boolean;
}) {
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3">
      <Button
        ref={resendRef}
        id="account-sign-in-code-resend"
        type="button"
        variant={dead ? "primary" : "secondary"}
        disabled={cooldownSeconds > 0 || resendStatus === "sending" || settling}
        aria-busy={resendStatus === "sending"}
        onClick={onResend}
      >
        {resendStatus === "sending" && (
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
        )}
        {cooldownSeconds > 0
          ? m.accountSignInCodeResendCooldown(
              { seconds: cooldownSeconds },
              { locale }
            )
          : m.accountSignInCodeResend({}, { locale })}
      </Button>
      {onUseDifferentEmail && (
        <Button
          type="button"
          variant="link"
          disabled={settling}
          onClick={onUseDifferentEmail}
        >
          {m.accountSignInCodeChangeEmail({}, { locale })}
        </Button>
      )}
    </div>
  );
}
