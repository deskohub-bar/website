import {
  CustomerBookingSelectionInvalid,
  CustomerPassesUnavailable,
  CustomerPassNotFound,
  CustomerPassPurchaseRefused,
  WorkspaceCustomerApi,
} from "@deskohub/workspace-customer-api";
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { CustomerAuthentication } from "@/features/account/backend/customer-authentication.service";
import { checkoutSubmitDeadline } from "@/features/checkout/backend/checkout/checkout-submit-deadline";
import { defaultLocale } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import {
  CustomerPassesClosed,
  HeldPassNotFound,
} from "@/features/passes/backend/customer-pass-reads";
import { CustomerPasses } from "@/features/passes/backend/customer-passes.service";
import { EntryPackPurchaseError } from "@/features/passes/backend/entry-pack-purchase";
import { providePerRequest } from "@/shared/backend/provide-per-request";
import { runToCompletion } from "@/shared/backend/run-to-completion";
import {
  answerCustomerApiFailure,
  type CustomerAccountApiFailure,
  type CustomerApiFailure,
} from "./customer-api-failure";
import { CustomerPassLayers } from "./customer-pass-layers";
import {
  beginCustomerPassPurchase,
  loadCustomerPassPurchaseStatus,
  loadCustomerUnlimitedStartDates,
  submitCustomerPassPurchase,
  updateCustomerPassPurchasePrice,
} from "./customer-pass-purchase-operations";
import { CustomerReservationLayers } from "./customer-reservation-layers";

type PassReadFailure = CustomerAccountApiFailure | CustomerPassesUnavailable;

const failPassRequest = <E>(
  operation: string,
  failure: E
): Effect.Effect<never, CustomerApiFailure<E> | CustomerPassesUnavailable> =>
  failure instanceof CustomerPassesClosed
    ? Effect.fail(new CustomerPassesUnavailable())
    : answerCustomerApiFailure(operation)(Effect.fail(failure));

const answerPassFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.catch((failure) => failPassRequest(operation, failure)));

type PassPurchaseFailure = PassReadFailure | CustomerPassPurchaseRefused;

const failPurchaseRequest = <E>(
  operation: string,
  failure: E
): Effect.Effect<never, PassPurchaseFailure | CustomerApiFailure<E>> => {
  if (failure instanceof CustomerPassPurchaseRefused)
    return Effect.fail(failure);
  if (failure instanceof Schema.SchemaError) {
    return Effect.fail(
      new CustomerPassPurchaseRefused({ reason: "invalid-selection" })
    );
  }
  if (failure instanceof EntryPackPurchaseError) {
    const { reason } = failure;
    return reason === "unavailable"
      ? Effect.fail(new CustomerPassesUnavailable())
      : Effect.fail(
          new CustomerPassPurchaseRefused({
            reason: reason === "terms-changed" ? "quote-expired" : reason,
          })
        );
  }
  return failPassRequest(operation, failure);
};

const answerPurchaseFailure =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catch((failure) => failPurchaseRequest(operation, failure))
    );

export const CustomerPassApiHandlers = HttpApiBuilder.group(
  WorkspaceCustomerApi,
  "passes",
  Effect.fn(function* (handlers) {
    const layers = yield* CustomerPassLayers;
    const reservations = yield* CustomerReservationLayers;
    const authentication = Layer.succeed(
      CustomerAuthentication,
      yield* CustomerAuthentication
    );
    const currentAccount = reservations.currentAccount.pipe(
      Layer.provide(authentication)
    );
    const shared = Layer.mergeAll(
      layers.passes,
      layers.release,
      currentAccount
    );
    const passReads = Layer.mergeAll(shared, layers.database);
    const beginPurchase = Layer.mergeAll(shared, layers.purchases.begin).pipe(
      Layer.provide(authentication)
    );
    const purchasePayment = Layer.mergeAll(
      shared,
      layers.purchases.payment
    ).pipe(Layer.provide(authentication));
    const purchaseReprice = Layer.mergeAll(
      shared,
      layers.purchases.reprice
    ).pipe(Layer.provide(authentication));

    return handlers
      .handle("listPassOffers", () =>
        Effect.flatMap(CustomerPasses, (passes) => passes.catalog()).pipe(
          providePerRequest(shared),
          answerPassFailure("customerApi.listPassOffers")
        )
      )
      .handle("listPasses", ({ query: { locale = defaultLocale } }) =>
        Effect.flatMap(CustomerPasses, (passes) => passes.list(locale)).pipe(
          providePerRequest(Layer.mergeAll(passReads, layers.inventory)),
          runToCompletion,
          answerPassFailure("customerApi.listPasses")
        )
      )
      .handle("getPassBookingOptions", ({ query }) =>
        Effect.flatMap(CustomerPasses, (passes) => passes.options(query)).pipe(
          providePerRequest(passReads),
          runToCompletion,
          Effect.catch(
            (
              failure
            ): Effect.Effect<
              never,
              PassReadFailure | CustomerBookingSelectionInvalid
            > =>
              failure instanceof Schema.SchemaError
                ? Effect.fail(
                    new CustomerBookingSelectionInvalid({ field: "date" })
                  )
                : failPassRequest("customerApi.getPassBookingOptions", failure)
          )
        )
      )
      .handle("getUnlimitedAccess", ({ params: { passId } }) =>
        Effect.flatMap(CustomerPasses, (passes) =>
          passes.todayCode(orderIdSchema.make(passId))
        ).pipe(
          providePerRequest(
            Layer.mergeAll(passReads, layers.accessCodes, layers.dotypos)
          ),
          runToCompletion,
          Effect.catch(
            (
              failure
            ): Effect.Effect<never, PassReadFailure | CustomerPassNotFound> =>
              failure instanceof HeldPassNotFound
                ? Effect.fail(new CustomerPassNotFound())
                : failPassRequest("customerApi.getUnlimitedAccess", failure)
          )
        )
      )
      .handle("getReservationPassFunding", ({ query: { orderIds } }) =>
        Effect.flatMap(CustomerPasses, (passes) =>
          passes.reservationFunding(orderIds)
        ).pipe(
          providePerRequest(passReads),
          answerPassFailure("customerApi.getReservationPassFunding")
        )
      )
      .handle("resendPassInvitation", ({ params: { passId } }) =>
        Effect.flatMap(CustomerPasses, (passes) =>
          passes.resendInvitation(orderIdSchema.make(passId))
        ).pipe(
          Effect.map((status) => ({ status })),
          providePerRequest(
            Layer.mergeAll(passReads, layers.giftInvitation).pipe(
              Layer.provide(authentication)
            )
          ),
          answerPassFailure("customerApi.resendPassInvitation")
        )
      )
      .handle("getUnlimitedStartDates", ({ query }) =>
        loadCustomerUnlimitedStartDates(query).pipe(
          providePerRequest(
            Layer.mergeAll(shared, layers.purchases.availability)
          ),
          Effect.timeout("18 seconds"),
          answerPurchaseFailure("customerApi.getUnlimitedStartDates")
        )
      )
      .handle("beginPassPurchase", ({ payload }) =>
        beginCustomerPassPurchase(payload).pipe(
          providePerRequest(beginPurchase),
          Effect.timeout("180 seconds"),
          answerPurchaseFailure("customerApi.beginPassPurchase")
        )
      )
      .handle(
        "getPassPurchaseStatus",
        ({ params, query: { locale = defaultLocale } }) =>
          loadCustomerPassPurchaseStatus(
            orderIdSchema.make(params.orderId),
            locale
          ).pipe(
            providePerRequest(Layer.mergeAll(shared, layers.purchases.status)),
            Effect.timeout("50 seconds"),
            runToCompletion,
            Effect.catch(
              (
                failure
              ): Effect.Effect<
                never,
                PassPurchaseFailure | CustomerPassNotFound
              > =>
                failure instanceof HeldPassNotFound
                  ? Effect.fail(new CustomerPassNotFound())
                  : failPurchaseRequest(
                      "customerApi.getPassPurchaseStatus",
                      failure
                    )
            )
          )
      )
      .handle("submitPassPurchase", ({ params, payload }) =>
        submitCustomerPassPurchase(
          orderIdSchema.make(params.orderId),
          payload
        ).pipe(
          providePerRequest(purchasePayment),
          Effect.timeout(checkoutSubmitDeadline),
          answerPurchaseFailure("customerApi.submitPassPurchase")
        )
      )
      .handle("updatePassPurchasePrice", ({ params, payload }) =>
        updateCustomerPassPurchasePrice(
          orderIdSchema.make(params.orderId),
          payload
        ).pipe(
          providePerRequest(purchaseReprice),
          Effect.timeout(checkoutSubmitDeadline),
          answerPurchaseFailure("customerApi.updatePassPurchasePrice")
        )
      );
  })
);
