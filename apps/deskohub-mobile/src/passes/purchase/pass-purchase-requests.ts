import {
  type BeginCustomerPassPurchase,
  type CustomerAccountId,
  type CustomerPassPurchase,
  CustomerSessionRequired,
  type SubmitCustomerPassPurchase,
  type UpdateCustomerPassPurchasePrice,
} from "@deskohub/workspace-customer-api";
import { Data, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { paymentBrowserLayer } from "../../booking/payment-browser";
import { PaymentBrowser } from "../../booking/payment-browser.service";
import { AccountExitFence } from "../../customer-api/account-scoped-storage";
import {
  CustomerAccountScope,
  CustomerApi,
  CustomerAuthApi,
} from "../../customer-api/customer-api.service";
import { customerDataRuntime } from "../../customer-api/customer-data-runtime";
import {
  customerRead,
  customerWrite,
} from "../../customer-api/customer-request";
import { CustomerRequestDispatch } from "../../customer-api/customer-request-dispatch";

const passesApi = Effect.map(Effect.service(CustomerApi), (api) => api.passes);

/** Recheck the signed-in cookie before sending gift or billing details. */
export const confirmPassPurchaseScope = Effect.Do.pipe(
  Effect.bind("scope", () => Effect.service(CustomerAccountScope)),
  Effect.bind("fence", () => Effect.service(AccountExitFence)),
  Effect.bind("auth", () => Effect.service(CustomerAuthApi)),
  Effect.bind("session", ({ auth }) => auth.auth.getSession({})),
  Effect.bind("buyerAccountId", ({ scope, session }) =>
    session !== null && session.user.id === scope.accountId
      ? Effect.succeed(session.user.id)
      : Effect.fail(new CustomerSessionRequired())
  ),
  Effect.bind("current", ({ scope, fence }) => fence.isCurrent(scope)),
  Effect.filterOrFail(
    ({ current }) => current,
    () => new CustomerSessionRequired()
  ),
  Effect.map(({ buyerAccountId }) => buyerAccountId),
  customerRead({ accountRead: false })
);

export const unlimitedStartDatesAtom = Atom.family(
  (supersedeOrderId: string | undefined | false) =>
    customerDataRuntime.atom(
      supersedeOrderId === false
        ? Effect.undefined
        : passesApi.pipe(
            Effect.flatMap((api) =>
              api.getUnlimitedStartDates({
                query:
                  supersedeOrderId === undefined ? {} : { supersedeOrderId },
              })
            ),
            customerRead({ accountRead: false })
          )
    )
);

class PassPurchaseViewChanged extends Data.TaggedError(
  "PassPurchaseViewChanged"
) {}

const confirmPurchaseAction = (owns?: () => boolean) =>
  confirmPassPurchaseScope.pipe(
    Effect.filterOrFail(
      () => owns?.() ?? true,
      () => new PassPurchaseViewChanged()
    )
  );

const writePass = <A, E, R>(
  write: (
    passes: Effect.Success<typeof passesApi>,
    buyerAccountId: CustomerAccountId
  ) => Effect.Effect<A, E, R>,
  owns?: () => boolean
) =>
  confirmPurchaseAction(owns).pipe(
    Effect.flatMap((buyerAccountId) =>
      passesApi.pipe(
        Effect.flatMap((passes) => write(passes, buyerAccountId)),
        Effect.updateService(CustomerRequestDispatch, (dispatch) => ({
          onSend: Effect.suspend(() =>
            owns?.() === false ? Effect.interrupt : dispatch.onSend
          ),
        })),
        customerWrite
      )
    )
  );

export const beginPassPurchaseAtom = customerDataRuntime.fn(
  ({
    payload,
    owns,
  }: {
    payload: BeginCustomerPassPurchase;
    owns?: () => boolean;
  }) =>
    writePass(
      (passes, expectedBuyerAccountId) =>
        passes.beginPassPurchase({
          payload: { ...payload, expectedBuyerAccountId },
        }),
      owns
    )
);

export const submitPassPurchaseAtom = customerDataRuntime.fn(
  ({
    orderId,
    payload,
    owns,
  }: {
    orderId: string;
    payload: SubmitCustomerPassPurchase;
    owns?: () => boolean;
  }) =>
    writePass(
      (passes) => passes.submitPassPurchase({ params: { orderId }, payload }),
      owns
    )
);

export const updatePassPurchasePriceAtom = customerDataRuntime.fn(
  ({
    orderId,
    payload,
    owns,
  }: {
    orderId: string;
    payload: UpdateCustomerPassPurchasePrice;
    owns?: () => boolean;
  }) =>
    writePass(
      (passes) =>
        passes.updatePassPurchasePrice({ params: { orderId }, payload }),
      owns
    )
);

export const openPassPaymentAtom = customerDataRuntime.fn(
  ({
    orderId,
    redirectUrl,
    owns,
  }: {
    orderId: string;
    redirectUrl: string;
    owns?: () => boolean;
  }) =>
    confirmPurchaseAction(owns).pipe(
      Effect.andThen(Effect.service(PaymentBrowser)),
      Effect.flatMap((browser) =>
        browser.open(redirectUrl, passPaymentReturnUrl(orderId))
      ),
      Effect.provide(paymentBrowserLayer)
    )
);

export const passPaymentReturnUrl = (orderId: string) =>
  `deskohub://passes/purchases/${encodeURIComponent(orderId)}?after=payment`;

export const passPurchaseStatusHref = (orderId: string) =>
  ({
    pathname: "/passes/purchases/[orderId]",
    params: { orderId, after: "payment" },
  }) as const;

export const passPaymentPayload = (
  quote: CustomerPassPurchase,
  billing: NonNullable<SubmitCustomerPassPurchase["billing"]>,
  returnTarget: NonNullable<SubmitCustomerPassPurchase["returnTarget"]>
): SubmitCustomerPassPurchase => ({
  productKind: quote.product.kind,
  accepted: true,
  acceptedDocuments: quote.disclosure.documents.map(({ key, hash }) => ({
    key,
    hash,
  })),
  ...(quote.product.kind === "unlimited" &&
    quote.disclosure.earlyStartRequest !== undefined && {
      unlimitedEarlyStartAccepted: true,
    }),
  displayedPriceFingerprint: quote.price.fingerprint,
  billing,
  returnTarget,
});
