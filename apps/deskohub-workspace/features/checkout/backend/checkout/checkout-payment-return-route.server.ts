import { Effect, Layer, Option, Schema } from "effect";
import { NextResponse } from "next/server";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  type PaymentReturnTarget,
  passPaymentReturnTargetParam,
  paymentReturnTargets,
} from "@/features/checkout/payment-return-target";
import type { Locale } from "@/features/i18n";
import { getLocalizedParamsDecoder } from "@/features/i18n/server/route-params";
import { orderIdSchema } from "@/features/order";
import { findOrderKind } from "@/features/order/backend/order-kind";
import { WorkspaceReservationRepository } from "@/features/reservation/backend/workspace-reservation.repository";
import {
  type WorkspaceReservationId,
  workspaceReservationIdSchema,
} from "@/features/reservation/persistence-contracts";
import { defineWorkspaceRoute } from "@/shared/backend/workspace-route";
import { publicUrl } from "@/shared/deployment/public-origin";
import { getSearchParamsDecoder } from "@/shared/utils";
import type { CheckoutStatusReturnOutcome } from "./checkout-status.service";
import { getPaymentReturnDestination } from "./payment-return-destination";
import { getReservationStatusPath } from "./reservation-status-url";

type LocalizedCheckoutPaymentRouteContext = {
  readonly params: Promise<{ locale: string; orderId: string }>;
};

type CheckoutPaymentReturn = {
  readonly locale: Locale;
  readonly orderId: WorkspaceReservationId;
  readonly outcome: CheckoutStatusReturnOutcome;
  readonly passReturnTarget: PaymentReturnTarget | undefined;
};

const decodeCheckoutPaymentParams = getLocalizedParamsDecoder({
  orderId: workspaceReservationIdSchema,
});

const decodeCheckoutPaymentSearchParams = getSearchParamsDecoder(
  Schema.Struct({
    outcome: Schema.Literals(["success", "cancelled"]),
  })
);
const decodePassReturnTarget = Schema.decodeUnknownOption(
  Schema.Literals(paymentReturnTargets)
);
const decodePassOrderId = Schema.decodeUnknownOption(orderIdSchema);

const decodeCheckoutPaymentReturn = Effect.fn("decodeCheckoutPaymentReturn")(
  function* (
    request: Request,
    { params }: LocalizedCheckoutPaymentRouteContext
  ) {
    const decodedParams = decodeCheckoutPaymentParams(
      yield* Effect.promise(() => params)
    );
    const routeParams = Option.getOrUndefined(decodedParams);
    if (!routeParams) return Option.none<CheckoutPaymentReturn>();

    const { locale, orderId } = routeParams;
    const searchParams = new URL(request.url).searchParams;
    const { outcome } = Option.getOrElse(
      decodeCheckoutPaymentSearchParams(Object.fromEntries(searchParams)),
      () => ({ outcome: "unknown" as const })
    );

    const passTargets = searchParams.getAll(passPaymentReturnTargetParam);
    const passReturnTarget =
      passTargets.length === 1
        ? Option.getOrUndefined(decodePassReturnTarget(passTargets[0]))
        : undefined;
    return Option.some({ locale, orderId, outcome, passReturnTarget });
  }
);

/**
 * The app screen a checkout submitted from an app returns to, when its
 * reservation stores one. A failed lookup returns to the site's status page,
 * which works in any browser.
 */
const findAppDestination = Effect.fn("checkout.paymentReturn.appDestination")(
  function* (orderId: WorkspaceReservationId) {
    const reservations = yield* WorkspaceReservationRepository;
    const target = yield* reservations.findPaymentReturnTarget(orderId);
    if (!target) return Option.none<string>();
    return Option.some(yield* getPaymentReturnDestination({ target, orderId }));
  },
  (effect, orderId) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Payment return target lookup failed; returning to the site status page",
          { orderId, errorTag: cause._tag }
        ).pipe(Effect.as(Option.none<string>()))
      )
    )
);

const findPassAppDestination = Effect.fn(
  "checkout.paymentReturn.passAppDestination"
)(
  function* ({ orderId: rawOrderId, passReturnTarget }: CheckoutPaymentReturn) {
    if (!passReturnTarget) return Option.none<string>();
    const orderId = Option.getOrUndefined(decodePassOrderId(rawOrderId));
    if (!orderId || (yield* findOrderKind(orderId)) !== "pass-purchase") {
      return Option.none<string>();
    }
    return Option.some(
      yield* getPaymentReturnDestination({
        kind: "pass-purchase",
        orderId,
        target: passReturnTarget,
      })
    );
  },
  Effect.catch(() =>
    Effect.logWarning("Pass payment return target lookup failed").pipe(
      Effect.as(Option.none<string>())
    )
  )
);

const redirectCheckoutPaymentReturn = Effect.fn(
  "checkout.redirectCheckoutPaymentReturn"
)(function* (request: Request, input: CheckoutPaymentReturn) {
  const passDestination = yield* findPassAppDestination(input);
  const appDestination = Option.isSome(passDestination)
    ? passDestination
    : yield* findAppDestination(input.orderId);
  // Provider returns may lack cookies; the status page owns authorization and reconciliation.
  const response = NextResponse.redirect(
    Option.getOrElse(appDestination, () =>
      publicUrl(
        getReservationStatusPath({
          locale: input.locale,
          orderId: input.orderId,
          outcome: input.outcome,
          setBypassCookie: true,
        }),
        request.url
      )
    )
  );
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
});

/**
 * Sends a hosted payment's return on to the app the checkout came from, or to
 * the site's status page. The outcome is only a hint: the status page and the
 * app's status request reconcile the payment.
 */
export const handleCheckoutPaymentReturn = (
  request: Request,
  context: LocalizedCheckoutPaymentRouteContext
) =>
  decodeCheckoutPaymentReturn(request, context).pipe(
    Effect.flatMap((decoded) =>
      decoded.pipe(
        Option.map((input) => redirectCheckoutPaymentReturn(request, input)),
        Option.getOrElse(() =>
          Effect.succeed(new NextResponse(null, { status: 404 }))
        )
      )
    )
  );

export const checkoutPaymentReturnGet = defineWorkspaceRoute(
  {
    operation: "checkout.payment-return",
    cancellation: "continue-after-disconnect",
    caller: "client",
  },
  (request, context: LocalizedCheckoutPaymentRouteContext) =>
    handleCheckoutPaymentReturn(request, context).pipe(
      Effect.provide(
        Layer.mergeAll(
          WorkspaceReservationRepository.Live,
          WorkspaceDatabase.Default
        )
      )
    )
);
