import "server-only";

import { Effect } from "effect";
import { CurrentCustomerAccount } from "@/features/account/backend/current-customer-account";
import { CustomerAccountContactService } from "@/features/account/backend/customer-account-contact.service";
import type { PassPurchaseBuyer } from "../pass-purchase-details";

export const readPassPurchaseBuyer = Effect.fn("readPassPurchaseBuyer")(
  function* () {
    const account = yield* CurrentCustomerAccount;
    const standing = yield* account.peek;
    switch (standing.kind) {
      case "signed-out":
      case "unverified":
        return { kind: "signed-out" } satisfies PassPurchaseBuyer;
      case "unlinked":
        return {
          kind: "profile-required",
          email: standing.session.email,
        } satisfies PassPurchaseBuyer;
      case "linked": {
        const contacts = yield* CustomerAccountContactService;
        const contact = yield* contacts.linkedContact({
          ...standing.account,
          email: standing.session.email,
        });
        return contact
          ? ({
              kind: "linked",
              name: contact.name,
              email: contact.email,
            } satisfies PassPurchaseBuyer)
          : ({ kind: "unavailable" } satisfies PassPurchaseBuyer);
      }
      default:
        return { kind: "unavailable" } satisfies PassPurchaseBuyer;
    }
  }
);
