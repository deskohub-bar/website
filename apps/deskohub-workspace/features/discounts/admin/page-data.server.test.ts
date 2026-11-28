import "@/shared/polyfills/temporal";
import "@/shared/testing/workspace-test-env";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { DotyposCustomerIdSchema, DotyposUnavailable } from "@deskohub/dotypos";
import { Effect, Layer, Predicate } from "effect";
import { mockAdministratorAccess } from "@/features/administrators/server/administrator-access.test-utils";
import {
  discountCodeIdSchema,
  voucherIdSchema,
} from "../persistence-contracts";
import { adminCustomerCode } from "./customer-admin-fixtures.test-utils";

const access = mockAdministratorAccess("discount-administration-pages");

mock.module("server-only", () => ({}));
mock.module("next/server", () => ({
  after: () => undefined,
  connection: () => Promise.resolve(),
}));

const { DiscountAdministration, DiscountAdminNotFoundError } = await import(
  "./discount-administration.service"
);
const pages = await import("./page-data.server");

type Administration = (typeof DiscountAdministration)["Service"];

let administration: Partial<Administration> = {};
const calls: string[] = [];
const originalLive = DiscountAdministration.Live;
DiscountAdministration.Live = Layer.suspend(() =>
  Layer.mock(DiscountAdministration, administration)
);

const codeId = discountCodeIdSchema.make(
  "019c91dd-c560-7e55-b9d8-c95065efd51d"
);
const voucherId = voucherIdSchema.make("019c91dd-c560-7e55-b9d8-c95065efd51e");
const customerId = DotyposCustomerIdSchema.make("customer-id");
const missingCustomer = new DiscountAdminNotFoundError({
  resource: { kind: "Dotypos customer", id: customerId },
  message: "missing",
});
const searchParams = () =>
  Promise.resolve({ notice: "Saved", status: "success" });

// The real `notFound` throws an error whose digest names the outcome.
const pageOutcome = async <A>(load: () => Promise<A>) => {
  try {
    return { kind: "ok" as const, value: await load() };
  } catch (signal) {
    if (
      Predicate.hasProperty(signal, "digest") &&
      signal.digest === "NEXT_HTTP_ERROR_FALLBACK;404"
    ) {
      return { kind: "not-found" as const };
    }
    throw signal;
  }
};

afterAll(() => {
  DiscountAdministration.Live = originalLive;
});

beforeEach(() => {
  access.set("administrator");
  administration = {};
  calls.length = 0;
});

describe("discount administration record pages", () => {
  const recordPages = [
    {
      read: "loadCodeDetail",
      load: () => pages.loadDiscountAdminCodePageData(codeId, searchParams()),
    },
    {
      read: "loadVoucherDetail",
      load: () =>
        pages.loadDiscountAdminVoucherPageData(voucherId, searchParams()),
    },
    {
      read: "loadCustomerCodeCreation",
      load: () =>
        pages.loadDiscountAdminCustomerCodeCreationPageData(customerId),
    },
    {
      read: "loadCustomerVoucherCreation",
      load: () =>
        pages.loadDiscountAdminCustomerVoucherCreationPageData(customerId),
    },
  ] as const;

  test.each(recordPages)(
    "answers a missing record with the ordinary 404 ($read)",
    async ({ load, read }) => {
      administration = {
        [read]: () => {
          calls.push(read);
          return Effect.fail(missingCustomer);
        },
      };

      expect(await pageOutcome(async () => await load())).toEqual({
        kind: "not-found",
      });
      expect(calls).toEqual([read]);
    }
  );

  test.each(recordPages)(
    "reads nothing for an account without the grant ($read)",
    async ({ load, read }) => {
      access.set("not-administrator");
      administration = {
        [read]: () => {
          calls.push(read);
          return Effect.fail(missingCustomer);
        },
      };

      expect(await pageOutcome(async () => await load())).toEqual({
        kind: "not-found",
      });
      expect(calls).toEqual([]);
    }
  );

  test("shows a record beside the page's notice", async () => {
    const code = adminCustomerCode({ id: codeId });
    const detail = {
      code,
      discountLabel: code.discountLabel,
      discountLabels: code.discountLabels,
      customers: [],
      claims: [],
    };
    administration = { loadCodeDetail: () => Effect.succeed(detail) };

    expect(
      await pageOutcome(() =>
        pages.loadDiscountAdminCodePageData(codeId, searchParams())
      )
    ).toEqual({
      kind: "ok",
      value: { detail, notice: { message: "Saved", status: "success" } },
    });
  });
});

describe("discount administration pages that never 404", () => {
  test("shows the customer page without discount sections it can't read", async () => {
    administration = {
      loadCustomerDiscountSections: () =>
        Effect.fail(
          new DotyposUnavailable({
            operation: "getCustomer",
            reason: "timeout",
          })
        ),
    };
    expect(
      await pages.loadDiscountCustomerSections(customerId, searchParams())
    ).toEqual({
      sections: null,
      notice: { message: "Saved", status: "success" },
    });
  });

  test("reads only the notice for the shell", async () => {
    expect(
      await pages.loadDiscountAdminShellPageData(
        Promise.resolve({ notice: "Saved", status: "unknown" })
      )
    ).toEqual({ notice: undefined });
    expect(calls).toEqual([]);
  });
});
