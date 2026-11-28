import type { DotyposCustomerId } from "@deskohub/dotypos";
import type { NexiCorrelationId } from "@deskohub/nexi";
import type { PaymentAttemptId } from "@deskohub/workspace-domain/features/checkout/checkout-identifiers";
import type {
  OrderFulfillmentState,
  OrderId,
  OrderKind,
  OrderPaymentState,
} from "@deskohub/workspace-domain/features/order/order";
import { type NewOrder, type Order, orders } from "./orders";

type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

// The order row carries branded domain identities, not bare strings.
type _OrderIdIsBranded = Expect<Equal<Order["id"], OrderId>>;
type _InsertIdIsBranded = Expect<Equal<NonNullable<NewOrder["id"]>, OrderId>>;
type _CorrelationIdIsBranded = Expect<
  Equal<Order["correlationId"], NexiCorrelationId>
>;
type _InsertCorrelationIdIsBranded = Expect<
  Equal<NonNullable<NewOrder["correlationId"]>, NexiCorrelationId>
>;
type _CustomerIdIsBranded = Expect<
  Equal<Order["dotyposCustomerId"], DotyposCustomerId>
>;
type _ActivePaymentAttemptIdIsBranded = Expect<
  Equal<Order["activePaymentAttemptId"], PaymentAttemptId | null>
>;

// Insert-time facts without defaults must be supplied by the caller. An
// optional column leaks `undefined` through the indexed access, so Equal
// against the bare domain type fails if the field stops being required.
type _KindIsRequired = Expect<Equal<NewOrder["kind"], OrderKind>>;
type _PaymentStateIsRequired = Expect<
  Equal<NewOrder["paymentState"], OrderPaymentState>
>;
type _FulfillmentStateIsRequired = Expect<
  Equal<NewOrder["fulfillmentState"], OrderFulfillmentState>
>;
type _CustomerIdIsRequired = Expect<
  Equal<NewOrder["dotyposCustomerId"], DotyposCustomerId>
>;

// Type-only values: a typecheck module never runs, so it reads no Temporal
// and decodes no identities.
declare const instant: Temporal.Instant;
declare const orderId: OrderId;
declare const correlationId: NexiCorrelationId;
declare const dotyposCustomerId: DotyposCustomerId;
declare const paymentAttemptId: PaymentAttemptId;

const validInsert: NewOrder = {
  kind: "reservation",
  correlationId,
  dotyposCustomerId,
  paymentState: "paid",
  fulfillmentState: "processing",
};
void validInsert;

const validSelect: Order = {
  id: orderId,
  kind: "reservation",
  correlationId,
  dotyposCustomerId,
  paymentState: "paid",
  fulfillmentState: "fulfilled",
  activePaymentAttemptId: paymentAttemptId,
  paidAt: instant,
  fulfilledAt: instant,
  fulfillmentFailedAt: null,
  fulfillmentFailureCode: null,
  createdAt: instant,
  updatedAt: instant,
};
void validSelect;

// Only the order kinds are valid order kinds.
type _GoodsKindIsRejected = Expect<
  "goods" extends NewOrder["kind"] ? false : true
>;

// Keep the table import live so the inferred types stay bound to the schema.
void orders;
