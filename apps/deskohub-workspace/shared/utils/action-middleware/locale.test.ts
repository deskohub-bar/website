import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Effect } from "effect";
import { sealSyntheticCoworkPayState } from "@/features/checkout/backend/checkout/pay-state.test-utils";
import type { OrderId } from "@/features/order";
import { createReservationAccessToken } from "@/features/reservation/backend/reservation-access-token";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";

const requestHeaders = new AsyncLocalStorage<Headers>();
const currentHeaders = () => requestHeaders.getStore() ?? new Headers();

mock.module("next/headers", () => ({
  headers: async () => currentHeaders(),
  cookies: async () => ({
    get: (name: string) => {
      const value = currentHeaders()
        .get("cookie")
        ?.split(";")
        .map((cookie) => cookie.trim().split("="))
        .find(([cookieName]) => cookieName === name)?.[1];
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

// The saved preference goes through the real reader over a fake session read
// that answers from the action request's headers.
const { makeFakeSavedLocalePreference, syntheticSessionCookie } = await import(
  "@/features/account/backend/saved-locale-preference.test-utils"
);
const reader = makeFakeSavedLocalePreference();
mock.module("@/features/account/server/saved-locale-preference.server", () => ({
  savedLocalePreference: reader.savedLocalePreference,
}));

const ownedPackOrder = "5413f44e-80ef-430e-9663-ddd7242a2ed0";
const entryPackOrders = await import(
  "@/features/passes/backend/entry-pack-order"
);
mock.module("@/features/passes/backend/entry-pack-order", () => ({
  ...entryPackOrders,
  readOwnedPassPurchaseOrderLocale: (orderId: OrderId) =>
    Effect.succeed(orderId === ownedPackOrder ? "en-US" : undefined),
}));

beforeEach(() => {
  reader.fake.savedPreference = undefined;
});

function request<T>(
  localeCookie: string | undefined,
  callback: () => T,
  {
    referer = "https://deskohub.test/checkout",
    signedIn = false,
  }: { readonly referer?: string; readonly signedIn?: boolean } = {}
) {
  const headers = new Headers({ referer });
  const cookies = [
    localeCookie && `PARAGLIDE_LOCALE=${localeCookie}`,
    signedIn && syntheticSessionCookie,
  ].filter(Boolean);
  if (cookies.length > 0) headers.set("cookie", cookies.join("; "));

  return requestHeaders.run(headers, callback);
}

async function createLocaleReader(
  beforeRead: () => Promise<unknown> = () => Promise.resolve()
) {
  const { createWorkspaceActionClient } = await import("../safe-action-client");
  const { m } = await import("@/features/i18n");
  const actionClient = createWorkspaceActionClient({
    logUnexpectedFailure: async () => {},
    unexpectedFailure: m.actionFailedUnexpectedly,
  });
  const { getLocale } = await import("@/features/i18n/paraglide/runtime.js");

  return actionClient.action(async ({ ctx }) => {
    await beforeRead();
    return { contextLocale: ctx.locale, messageLocale: getLocale() };
  });
}

describe("action locale middleware", () => {
  test("a request without a locale cookie keeps the fallback after an English request", async () => {
    const readLocale = await createLocaleReader();

    await request("en-US", () => readLocale());
    const result = await request(undefined, () => readLocale());

    expect(result.data).toEqual({
      contextLocale: "cs-CZ",
      messageLocale: "cs-CZ",
    });
  });

  test("overlapping requests each read their own locale", async () => {
    const bothStarted = Promise.withResolvers<void>();
    let started = 0;
    const readLocale = await createLocaleReader(() => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      return bothStarted.promise;
    });

    const [czech, english] = await Promise.all([
      request("cs-CZ", () => readLocale()),
      request("en-US", () => readLocale()),
    ]);

    expect(czech.data).toEqual({
      contextLocale: "cs-CZ",
      messageLocale: "cs-CZ",
    });
    expect(english.data).toEqual({
      contextLocale: "en-US",
      messageLocale: "en-US",
    });
  });

  test("the referring page's locale outranks the cookie", async () => {
    const readLocale = await createLocaleReader();

    const result = await request("en-US", () => readLocale(), {
      referer: "https://deskohub.test/cs-CZ/checkout",
    });

    expect(result.data).toEqual({
      contextLocale: "cs-CZ",
      messageLocale: "cs-CZ",
    });
  });

  test("a signed-in customer's saved preference outranks the referring page and cookie", async () => {
    reader.fake.savedPreference = "cs-CZ";
    const readLocale = await createLocaleReader();

    const result = await request("en-US", () => readLocale(), {
      referer: "https://deskohub.test/en-US/account",
      signedIn: true,
    });

    expect(result.data).toEqual({
      contextLocale: "cs-CZ",
      messageLocale: "cs-CZ",
    });
  });

  test("a signed-in action sent without a referrer follows the saved preference", async () => {
    reader.fake.savedPreference = "cs-CZ";
    const readLocale = await createLocaleReader();

    const result = await request("en-US", () => readLocale(), {
      referer: "",
      signedIn: true,
    });

    expect(result.data).toEqual({
      contextLocale: "cs-CZ",
      messageLocale: "cs-CZ",
    });
  });

  test("an action from a page carrying a validly signed Pay state keeps that page's locale", async () => {
    reader.fake.savedPreference = "cs-CZ";
    const readLocale = await createLocaleReader();
    const payState = encodeURIComponent(
      await sealSyntheticCoworkPayState({ locale: "en-US" })
    );

    const result = await request("cs-CZ", () => readLocale(), {
      referer: `https://deskohub.test/en-US/checkout/pay?payState=${payState}`,
      signedIn: true,
    });

    expect(result.data).toEqual({
      contextLocale: "en-US",
      messageLocale: "en-US",
    });
  });

  test("an action from an owned Entry pack checkout keeps its issued locale", async () => {
    reader.fake.savedPreference = "cs-CZ";
    const readLocale = await createLocaleReader();

    for (const [order, expectedLocale] of [
      [ownedPackOrder, "en-US"],
      ["ec53ffbb-eae2-477c-b9ae-7b29e4525b25", "cs-CZ"],
      ["malformed", "cs-CZ"],
    ]) {
      const result = await request("cs-CZ", () => readLocale(), {
        referer: `https://deskohub.test/en-US/passes/entry-pack?order=${order}&step=pay`,
        signedIn: true,
      });

      expect(result.data).toEqual({
        contextLocale: expectedLocale,
        messageLocale: expectedLocale,
      });
    }
  });

  test("an action from a page with a continuation parameter it does not support follows the preference", async () => {
    reader.fake.savedPreference = "cs-CZ";
    const readLocale = await createLocaleReader();

    const result = await request("en-US", () => readLocale(), {
      referer: "https://deskohub.test/en-US/gallery?payState=synthetic",
      signedIn: true,
    });

    expect(result.data).toEqual({
      contextLocale: "cs-CZ",
      messageLocale: "cs-CZ",
    });
  });

  test("an action from a validly signed invoice page keeps that page's locale", async () => {
    reader.fake.savedPreference = "cs-CZ";
    const readLocale = await createLocaleReader();
    const orderId = workspaceReservationIdSchema.make("reservation-id");
    const accessToken = encodeURIComponent(
      Effect.runSync(createReservationAccessToken({ orderId, locale: "en-US" }))
    );

    const result = await request("cs-CZ", () => readLocale(), {
      referer: `https://deskohub.test/en-US/reservation/invoice/${orderId}?accessToken=${accessToken}`,
      signedIn: true,
    });

    expect(result.data).toEqual({
      contextLocale: "en-US",
      messageLocale: "en-US",
    });
  });

  test("an action from a page with an invalid Pay state follows the preference", async () => {
    reader.fake.savedPreference = "cs-CZ";
    const readLocale = await createLocaleReader();

    const result = await request("en-US", () => readLocale(), {
      referer:
        "https://deskohub.test/en-US/reservation/cowork?payState=garbage",
      signedIn: true,
    });

    expect(result.data).toEqual({
      contextLocale: "cs-CZ",
      messageLocale: "cs-CZ",
    });
  });

  test("an action from a page whose Pay state the page would not read as is follows the preference", async () => {
    reader.fake.savedPreference = "cs-CZ";
    const readLocale = await createLocaleReader();
    const payState = encodeURIComponent(
      await sealSyntheticCoworkPayState({ locale: "en-US" })
    );

    for (const query of [
      `payState=%20${payState}`,
      `payState=garbage&payState=${payState}`,
    ]) {
      const result = await request("en-US", () => readLocale(), {
        referer: `https://deskohub.test/en-US/checkout/pay?${query}`,
        signedIn: true,
      });

      expect(result.data).toEqual({
        contextLocale: "cs-CZ",
        messageLocale: "cs-CZ",
      });
    }
  });
});
