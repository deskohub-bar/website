import "@/shared/polyfills/temporal";
import { standaloneReservationOrderId } from "@/features/reservation/reservation-order-id.test-utils";
import "@/shared/testing/workspace-test-env";

import { describe, expect, type Mock, mock, test } from "bun:test";
import { DotyposCustomerIdSchema } from "@deskohub/dotypos";
import { Effect, Layer } from "effect";
import { testLinkedAccount } from "@/features/account/backend/account-operations.test-utils";
import {
  peeking,
  testPeekedStandings,
} from "@/features/account/backend/current-customer-account.test-utils";
import { CustomerAccountReservationOwnership } from "@/features/account/backend/customer-account-reservation-ownership";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import {
  sealSyntheticPayStateToken,
  syntheticPayStateOrderId,
} from "@/features/checkout/backend/checkout/signed-pay-state.test-utils";
import { QrPaymentRepository } from "@/features/checkout/backend/repositories/qr-payment.repository";
import { paymentAttemptIdSchema } from "@/features/checkout/checkout-identifiers";
import type { ReferralService } from "@/features/referrals/referral.service";
import { ReferralReleaseGate } from "@/features/referrals/referral-release-gate";
import { RememberedReferral } from "@/features/referrals/remembered-referral.service";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import { workspaceReservationFixture } from "@/features/reservation/backend/workspace-reservation.test-utils";
import { customerAgentNames } from "@/shared/bot-protection/customer-agents";
import { TestSealedStateKeys } from "@/shared/testing/sealed-state-keys.test-utils";

mock.module("server-only", () => ({}));

let rememberedReferralCode: string | undefined;

const input = {
  locale: "en-US" as const,
  payStateToken: "pay-state-token",
  legalConsent: true,
  earlyPerformanceConsent: true,
};

const runSubmitReservation = async (options?: {
  readonly locale?: "cs-CZ" | "en-US";
  readonly verifyHuman?: ReturnType<typeof mock>;
  readonly createHostedPaymentCheckout?: ReturnType<typeof mock>;
  readonly method?: "card" | "qr";
  readonly startReservationPayment?: ReturnType<typeof mock>;
  readonly enableQr?: boolean;
  readonly anotherAccount?: boolean;
  readonly legacyActivePayment?: boolean;
  readonly pinnedAccountKey?: string;
  readonly alreadyPaid?: boolean;
  readonly invalidPayState?: boolean;
  readonly bookerCustomerId?: string;
  readonly hasSettledReferral?: Mock<
    (typeof ReferralService)["Service"]["hasSettledReferral"]
  >;
}) => {
  const { CheckoutService } = await import(
    "@/features/checkout/backend/checkout"
  );
  const { submitWorkspaceReservation } = await import(
    "./submit-workspace-reservation"
  );
  const { FioAccounts } = await import(
    "@/features/checkout/backend/fio/fio-accounts.service"
  );
  const { BotProtectionServiceMock } = await import(
    "@/shared/backend/bot-protection/bot-protection.service.mock"
  );
  const { ReferralServiceMock } = await import(
    "@/features/referrals/referral.service.mock"
  );
  const hasSettledReferral =
    options?.hasSettledReferral ?? mock(() => Effect.succeed(false));
  const cookie = { value: rememberedReferralCode };

  const verifyHuman = options?.verifyHuman ?? mock(() => Effect.void);
  const createHostedPaymentCheckout =
    options?.createHostedPaymentCheckout ??
    mock(() =>
      Effect.succeed({
        status: "redirect" as const,
        redirectUrl: "https://payments.example.test/checkout",
        statusUrl:
          "/en-US/reservation/status/0198c1a2-61c4-7e64-83f3-b3b69dc0dac5",
      })
    );

  const currentAccount = peeking(
    options?.bookerCustomerId === undefined
      ? testPeekedStandings["signed out"]
      : {
          ...testPeekedStandings.linked,
          account: {
            ...testLinkedAccount,
            dotyposCustomerId: DotyposCustomerIdSchema.make(
              options.bookerCustomerId
            ),
          },
        }
  );
  const referrals = ReferralServiceMock({
    hasSettledReferral,
  });
  const payStateToken =
    options?.method && !options.invalidPayState
      ? await sealSyntheticPayStateToken()
      : input.payStateToken;
  const unpaidState =
    options?.legacyActivePayment || options?.pinnedAccountKey
      ? "pending"
      : "not_started";
  const effect = submitWorkspaceReservation({
    ...input,
    payStateToken,
    locale: options?.locale ?? input.locale,
    ...(options?.method && { method: options.method }),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BotProtectionServiceMock({ verifyHuman }),
        Layer.succeed(CheckoutService, {
          createHostedPaymentCheckout,
          startReservationPayment:
            options?.startReservationPayment ??
            (() => Effect.succeed({ status: "in_progress" })),
          resumeReservationPayment: () =>
            Effect.succeed({ status: "in_progress" }),
        }),
        Layer.succeed(FioAccounts, {
          getDefaultReceivingAccount: () =>
            options?.enableQr
              ? {
                  accountKey: "synthetic-key",
                  accountNumber: "123",
                  bankCode: "0600",
                }
              : undefined,
          getReceivingAccount: () => undefined,
          getReceivingAccountDisplay: (accountKey) =>
            accountKey === options?.pinnedAccountKey
              ? { accountKey, accountNumber: "456", bankCode: "0600" }
              : undefined,
        }),
        Layer.mock(QrPaymentRepository, {
          findPaymentWindow: (reservationId) =>
            Effect.succeed(
              // The pinned window belongs to the signed reservation only.
              options?.pinnedAccountKey &&
                reservationId === syntheticPayStateOrderId
                ? {
                    orderId: standaloneReservationOrderId(reservationId),
                    accountKey: options.pinnedAccountKey,
                    expiresAt: Temporal.Now.instant().add({ minutes: 1 }),
                    cardAttemptId: null,
                    qrAttemptId: null,
                  }
                : null
            ),
        }),
        Layer.mock(CustomerAccountReservationOwnership, {
          activeAccountId: Effect.succeed(
            options?.anotherAccount
              ? customerAccountIdSchema.make("other-author")
              : testLinkedAccount.accountId
          ),
        }),
        Layer.mock(WorkspaceReservationRepository, {
          findById: (id) =>
            Effect.succeed(
              workspaceReservationFixture({
                id,
                authorAccountId: testLinkedAccount.accountId,
                reservationState: options?.alreadyPaid ? "confirmed" : "held",
                paymentState: options?.alreadyPaid ? "paid" : unpaidState,
                activePaymentAttemptId: options?.legacyActivePayment
                  ? paymentAttemptIdSchema.make("legacy-card-attempt")
                  : null,
              })
            ),
        }),
        TestSealedStateKeys,
        referrals,
        ReferralReleaseGate.fromDecision(true),
        RememberedReferral.inMemory(cookie).pipe(
          Layer.provide(
            Layer.mergeAll(
              ReferralReleaseGate.fromDecision(true),
              referrals,
              currentAccount
            )
          )
        )
      )
    )
  );

  return {
    effect,
    payStateToken,
    cookie,
    verifyHuman,
    createHostedPaymentCheckout,
  };
};

describe("submitWorkspaceReservation", () => {
  test.each(["card", "qr"] as const)(
    "returns the paid reservation to a second signed Pay tab using %s",
    async (method) => {
      const redirectUrl =
        "/en-US/reservation/status/0198c1a2-61c4-7e64-83f3-b3b69dc0dac5?outcome=success";
      const createHostedPaymentCheckout = mock(() =>
        Effect.succeed({
          status: "redirect" as const,
          redirectUrl,
          paid: true as const,
        })
      );
      const startReservationPayment = mock();
      const { effect } = await runSubmitReservation({
        method,
        alreadyPaid: true,
        enableQr: true,
        createHostedPaymentCheckout,
        startReservationPayment,
      });
      expect(await Effect.runPromise(effect)).toMatchObject({
        status: "redirect",
        redirectUrl,
        paid: true,
      });
      expect(createHostedPaymentCheckout).toHaveBeenCalledTimes(1);
      expect(startReservationPayment).not.toHaveBeenCalled();
    }
  );

  test.each([{ anotherAccount: true }, { invalidPayState: true }])(
    "does not disclose the paid redirect to an unverified signed tab (%o)",
    async (options) => {
      const { effect, createHostedPaymentCheckout } =
        await runSubmitReservation({
          ...options,
          method: "qr",
          alreadyPaid: true,
          enableQr: true,
        });
      expect(await Effect.runPromise(Effect.result(effect))).toMatchObject({
        _tag: "Failure",
      });
      expect(createHostedPaymentCheckout).not.toHaveBeenCalled();
    }
  );

  test("does not return a hosted card page to a signed QR submission if card started concurrently", async () => {
    const startReservationPayment = mock(() =>
      Effect.succeed({
        status: "redirect" as const,
        redirectUrl: "https://payments.example.test/legacy-card",
      })
    );
    const { effect } = await runSubmitReservation({
      enableQr: true,
      method: "qr",
      startReservationPayment,
    });
    expect(await Effect.runPromise(Effect.result(effect))).toMatchObject({
      _tag: "Failure",
    });
    expect(startReservationPayment).toHaveBeenCalledTimes(1);
  });

  test("keeps an existing signed payment window pinned when the default account changes", async () => {
    const startReservationPayment = mock(() =>
      Effect.succeed({ status: "in_progress" as const })
    );
    const { effect } = await runSubmitReservation({
      enableQr: true,
      method: "qr",
      pinnedAccountKey: "original-account",
      startReservationPayment,
    });
    await Effect.runPromise(effect);
    expect(startReservationPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        fio: { accountKey: "original-account" },
        method: "qr",
      }),
      "en-US"
    );
  });

  test("refuses explicit QR on a held order with a pre-release active card payment", async () => {
    const startReservationPayment = mock(() =>
      Effect.succeed({
        status: "redirect" as const,
        redirectUrl: "https://payments.example.test/legacy-card",
      })
    );
    const { effect, createHostedPaymentCheckout } = await runSubmitReservation({
      enableQr: true,
      method: "qr",
      legacyActivePayment: true,
      startReservationPayment,
    });
    expect(await Effect.runPromise(Effect.result(effect))).toMatchObject({
      _tag: "Failure",
    });
    expect(startReservationPayment).not.toHaveBeenCalled();
    expect(createHostedPaymentCheckout).not.toHaveBeenCalled();
  });

  test.each(["card", "qr"] as const)(
    "denies a gated %s submission from a nonauthor with the signed Pay link",
    async (method) => {
      const startReservationPayment = mock(() =>
        Effect.succeed({ status: "in_progress" as const })
      );
      const { effect, createHostedPaymentCheckout } =
        await runSubmitReservation({
          method,
          enableQr: true,
          anotherAccount: true,
          startReservationPayment,
        });

      expect(await Effect.runPromise(Effect.result(effect))).toMatchObject({
        _tag: "Failure",
      });
      expect(startReservationPayment).not.toHaveBeenCalled();
      expect(createHostedPaymentCheckout).not.toHaveBeenCalled();
    }
  );

  test("keeps card checkout on the hosted path when QR is disabled", async () => {
    const startReservationPayment = mock(() =>
      Effect.succeed({ status: "in_progress" as const })
    );
    const { effect, createHostedPaymentCheckout } = await runSubmitReservation({
      method: "card",
      startReservationPayment,
    });

    expect((await Effect.runPromise(effect)).status).toBe("redirect");
    expect(createHostedPaymentCheckout).toHaveBeenCalledTimes(1);
    expect(startReservationPayment).not.toHaveBeenCalled();
  });

  test("rejects a direct QR submission when QR is disabled", async () => {
    const startReservationPayment = mock(() =>
      Effect.succeed({ status: "in_progress" as const })
    );
    const { effect, createHostedPaymentCheckout } = await runSubmitReservation({
      method: "qr",
      startReservationPayment,
    });

    expect(await Effect.runPromise(Effect.result(effect))).toMatchObject({
      _tag: "Failure",
    });
    expect(createHostedPaymentCheckout).not.toHaveBeenCalled();
    expect(startReservationPayment).not.toHaveBeenCalled();
  });

  test("starts a gated QR payment and returns only the Workspace status URL", async () => {
    const orderId = "658d5a17-1ccc-4d97-baab-6cbb015125ca" as const;
    const startReservationPayment = mock(() =>
      Effect.succeed({
        status: "qr_pending",
        orderId,
        accountKey: "synthetic-key",
        variableSymbol: "0000001234",
        amount: { value: 45050, currency: "CZK", exponent: 2 },
        expiresAt: Temporal.Instant.from("2026-11-20T14:30:00Z"),
      } as const)
    );
    const { effect, payStateToken, createHostedPaymentCheckout } =
      await runSubmitReservation({
        enableQr: true,
        method: "qr",
        startReservationPayment,
      });
    const result = await Effect.runPromise(effect);
    expect(startReservationPayment).toHaveBeenCalledWith(
      {
        payStateToken,
        legalConsent: true,
        earlyPerformanceConsent: true,
        method: "qr",
        fio: { accountKey: "synthetic-key" },
      },
      "en-US"
    );
    expect(createHostedPaymentCheckout).not.toHaveBeenCalled();
    expect(result).toEqual({
      message: "Checkout started successfully",
      status: "qr_pending",
      statusUrl: `/en-US/reservation/status/${orderId}`,
    });
  });

  test("verifies with the allow policy before creating checkout", async () => {
    const eventOrder: string[] = [];
    const verifyHuman = mock(() =>
      Effect.sync(() => {
        eventOrder.push("bot-verification");
      })
    );
    const createHostedPaymentCheckout = mock(() =>
      Effect.sync(() => {
        eventOrder.push("checkout");
        return {
          status: "redirect" as const,
          redirectUrl: "https://payments.example.test/checkout",
          statusUrl:
            "/en-US/reservation/status/0198c1a2-61c4-7e64-83f3-b3b69dc0dac5",
        };
      })
    );
    const scenario = await runSubmitReservation({
      verifyHuman,
      createHostedPaymentCheckout,
    });

    const result = await Effect.runPromise(scenario.effect);

    expect(verifyHuman).toHaveBeenCalledWith({
      verificationFailurePolicy: "allow",
      verifiedBots: { allow: customerAgentNames },
      callSite: "reservation.submit",
    });
    expect(eventOrder).toEqual(["bot-verification", "checkout"]);
    expect(createHostedPaymentCheckout).toHaveBeenCalledWith(
      {
        payStateToken: input.payStateToken,
        legalConsent: true,
        earlyPerformanceConsent: true,
      },
      "en-US"
    );
    expect(result).toEqual({
      message: "Checkout started successfully",
      status: "redirect",
      redirectUrl: "https://payments.example.test/checkout",
      statusUrl:
        "/en-US/reservation/status/0198c1a2-61c4-7e64-83f3-b3b69dc0dac5",
    });
  });

  test.each([
    [
      "a hosted payment",
      {
        status: "redirect",
        orderId: "0198c1a2-61c4-7e64-83f3-b3b69dc0dac5",
        redirectUrl: "https://payments.example.test/checkout",
        statusUrl:
          "/en-US/reservation/status/0198c1a2-61c4-7e64-83f3-b3b69dc0dac5",
      },
      ["message", "redirectUrl", "status", "statusUrl"],
    ],
    [
      "a paid order",
      {
        status: "redirect",
        orderId: "0198c1a2-61c4-7e64-83f3-b3b69dc0dac5",
        redirectUrl:
          "/en-US/reservation/status/0198c1a2-61c4-7e64-83f3-b3b69dc0dac5",
        paid: true,
      },
      ["message", "paid", "redirectUrl", "status"],
    ],
    [
      "a changed price",
      {
        status: "pricing_changed",
        changedKeys: { sectionKeys: [], itemKeys: [] },
        freshSummary: { sections: [] },
        freshPayUrl: "/en-US/checkout/pay?payState=fresh",
        freshPayStateToken: "fresh-token",
        expiresAt: "2099-07-01T10:13:00.000Z",
      },
      ["changedKeys", "freshPayUrl", "freshSummary", "message", "status"],
    ],
    ["a payment in progress", { status: "in_progress" }, ["message", "status"]],
  ] as const)(
    "answers the Pay page %s without the API's checkout fields",
    async (_label, checkout, keys) => {
      const scenario = await runSubmitReservation({
        createHostedPaymentCheckout: mock(() => Effect.succeed(checkout)),
      });

      const result = await Effect.runPromise(scenario.effect);

      expect(Object.keys(result).toSorted()).toEqual([...keys]);
    }
  );

  test.each([
    [
      "zero-total",
      "/en-US/reservation/status/reservation-zero-total?outcome=success",
    ],
  ] as const)(
    "preserves the %s internal redirect when only redirectUrl is returned",
    async (_label, redirectUrl) => {
      const createHostedPaymentCheckout = mock(() =>
        Effect.succeed({
          status: "redirect" as const,
          redirectUrl,
        })
      );
      const scenario = await runSubmitReservation({
        createHostedPaymentCheckout,
      });

      await expect(Effect.runPromise(scenario.effect)).resolves.toEqual({
        message: "Checkout started successfully",
        status: "redirect",
        redirectUrl,
      });
    }
  );

  test.each(["zero-total"] as const)(
    "forgets the remembered referral code once the %s checkout is paid",
    async (label) => {
      rememberedReferralCode = "RFL12345";
      const redirectUrl = `/en-US/reservation/status/reservation-${label}?outcome=success`;
      const scenario = await runSubmitReservation({
        createHostedPaymentCheckout: mock(() =>
          Effect.succeed({
            status: "redirect" as const,
            redirectUrl,
            paid: true,
          })
        ),
      });

      await expect(Effect.runPromise(scenario.effect)).resolves.toEqual({
        message: "Checkout started successfully",
        status: "redirect",
        redirectUrl,
        paid: true,
      });
      expect(scenario.cookie.value).toBeUndefined();
    }
  );

  test.each([
    ["a settled friend keeps the booker's code", false, "RFL12345"],
    ["a settled booker clears the booker's code", true, undefined],
  ] as const)(
    "checks the signed-in booker's own customer after a paid checkout: %s",
    async (_label, bookerSettled, codeAfter) => {
      rememberedReferralCode = "RFL12345";
      const hasSettledReferral = mock(() => Effect.succeed(bookerSettled));
      const scenario = await runSubmitReservation({
        createHostedPaymentCheckout: mock(() =>
          Effect.succeed({
            status: "redirect" as const,
            redirectUrl: "/en-US/reservation/status/reservation-friend",
            paid: true,
          })
        ),
        bookerCustomerId: "booker-customer",
        hasSettledReferral,
      });

      await Effect.runPromise(scenario.effect);

      expect(hasSettledReferral.mock.calls).toEqual([
        [{ dotyposCustomerId: "booker-customer" }],
      ]);
      expect(scenario.cookie.value).toBe(codeAfter);
    }
  );

  test("keeps the remembered referral code while a hosted payment is pending", async () => {
    rememberedReferralCode = "RFL12345";
    const scenario = await runSubmitReservation();

    await Effect.runPromise(scenario.effect);

    expect(scenario.cookie.value).toBe("RFL12345");
  });

  test.each(["en-US", "cs-CZ"] as const)(
    "rejects a classified bot before creating checkout in %s",
    async (locale) => {
      const { BotDetectedError } = await import(
        "@/shared/backend/bot-protection/bot-protection.service"
      );
      const { m } = await import("@/features/i18n");
      const verifyHuman = mock(() =>
        Effect.fail(
          new BotDetectedError({
            message: "Automated request detected",
            reason: "unverified_bot",
          })
        )
      );
      const scenario = await runSubmitReservation({ verifyHuman, locale });

      const error = await Effect.runPromise(Effect.flip(scenario.effect));

      expect(error).toMatchObject({
        _tag: "PublicSafeActionError",
        message: m.automatedRequestRejected({}, { locale }),
      });
      expect(scenario.createHostedPaymentCheckout).not.toHaveBeenCalled();
    }
  );

  test("maps cowork availability failures from their typed cause", async () => {
    const { CheckoutError } = await import(
      "@/features/checkout/backend/checkout"
    );
    const { getReservationAvailabilityUnavailableMessage } = await import(
      "@/features/reservation/reservation.i18n"
    );
    const { WorkspaceTableUnavailableError } = await import(
      "@/features/reservation/backend/workspace-availability.service"
    );
    const createHostedPaymentCheckout = mock(() =>
      Effect.fail(
        new CheckoutError({
          code: "checkout_failed",
          message: "workspace_table_unavailable",
          cause: new WorkspaceTableUnavailableError({
            date: "2099-07-30",
            reservation: { kind: "cowork", entryTier: "basic" },
          }),
        })
      )
    );
    const scenario = await runSubmitReservation({
      createHostedPaymentCheckout,
    });

    const error = await Effect.runPromise(Effect.flip(scenario.effect));

    expect(error).toMatchObject({
      _tag: "PublicSafeActionError",
      message: getReservationAvailabilityUnavailableMessage({
        date: "2099-07-30",
        locale: "en-US",
        reservation: { kind: "cowork", entryTier: "basic" },
      }),
    });
  });

  test.each([
    { code: "legal_consent_required", locale: "en-US" },
    { code: "early_performance_consent_required", locale: "en-US" },
    { code: "legal_consent_required", locale: "cs-CZ" },
    { code: "early_performance_consent_required", locale: "cs-CZ" },
  ] as const)(
    "shows the generic checkout failure for $code in $locale",
    async ({ code, locale }) => {
      const { CheckoutError } = await import(
        "@/features/checkout/backend/checkout"
      );
      const { m } = await import("@/features/i18n");
      const failSubmission = async (
        error: InstanceType<typeof CheckoutError>
      ) =>
        Effect.runPromise(
          Effect.flip(
            (
              await runSubmitReservation({
                locale,
                createHostedPaymentCheckout: mock(() => Effect.fail(error)),
              })
            ).effect
          )
        );

      const consentFailure = await failSubmission(
        new CheckoutError({ code, message: "Consent is required." })
      );
      const genericFailure = await failSubmission(
        new CheckoutError({
          code: "checkout_failed",
          message: "Checkout failed.",
        })
      );

      expect(consentFailure).toMatchObject({
        _tag: "PublicSafeActionError",
        message: m.reservationErrorMessage({}, { locale }),
      });
      expect(consentFailure.message).toBe(genericFailure.message);
    }
  );
});
