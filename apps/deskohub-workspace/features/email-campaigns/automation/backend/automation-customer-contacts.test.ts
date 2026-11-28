import "@/shared/testing/workspace-test-env";
import { describe, expect, test } from "bun:test";
import {
  DotyposCloudIdSchema,
  type DotyposCustomer,
  DotyposCustomerIdSchema,
} from "@deskohub/dotypos";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Option } from "effect";
import { inactiveCustomerDisplayNames } from "@/features/administration/customer-name";
import { readAutomationCustomerContacts } from "./automation-customer-contacts";

const customer = (
  id: string,
  fields: Partial<DotyposCustomer> = {}
): DotyposCustomer => ({
  id: DotyposCustomerIdSchema.make(id),
  _cloudId: DotyposCloudIdSchema.make("automation-contacts-cloud"),
  firstName: "Synthetic",
  lastName: id,
  email: testEmailAddress(id),
  phone: "+420 600 000 000",
  deleted: false,
  display: true,
  points: "0",
  flags: "0",
  ...fields,
});

const read = (customers: readonly DotyposCustomer[]) =>
  Effect.runPromise(
    readAutomationCustomerContacts(customers.map(({ id }) => id)).pipe(
      Effect.provide(makeInMemoryDotypos({ customers }).layer)
    )
  ).then(Option.getOrThrow);

describe("readAutomationCustomerContacts", () => {
  test("reads an active customer's name, email and lifecycle", async () => {
    const active = customer("customer-active");
    const contacts = await read([active]);

    expect(contacts.get(active.id)).toEqual({
      name: "Synthetic customer-active",
      email: testEmailAddress("customer-active"),
      lifecycle: "active",
    });
  });

  test.each([
    ["deleted", { deleted: true }],
    ["expired", { expireDate: "2020-01-01T00:00:00Z" }],
  ] as const)(
    "names a %s customer only by the placeholder, without their email, and keeps the lifecycle",
    async (lifecycle, fields) => {
      const inactive = customer(`customer-${lifecycle}`, fields);
      const contacts = await read([inactive]);

      expect(contacts.get(inactive.id)).toEqual({
        name: inactiveCustomerDisplayNames[lifecycle],
        email: null,
        lifecycle,
      });
    }
  );
});
