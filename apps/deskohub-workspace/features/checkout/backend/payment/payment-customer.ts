import type { DotyposCustomerId } from "@deskohub/dotypos";
import { type PhoneNumber, phoneNumberParts } from "@deskohub/phone-number";
import { Option } from "effect";
import type { PaymentCustomer } from "./payment-provider";

/** The customer a hosted payment page prefills; without a phone it has no mobile phone. */
export const getPaymentCustomer = (input: {
  readonly id: DotyposCustomerId;
  readonly name: string;
  readonly email: string;
  readonly phone: Option.Option<PhoneNumber>;
}): PaymentCustomer => ({
  id: input.id,
  name: input.name,
  email: input.email,
  ...Option.match(input.phone, {
    onNone: () => ({}),
    onSome: (phone) => ({ mobilePhone: phoneNumberParts(phone) }),
  }),
});
