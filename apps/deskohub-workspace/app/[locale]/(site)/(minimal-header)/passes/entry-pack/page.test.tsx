import { expect, mock, test } from "bun:test";
import { Effect } from "effect";
import { getAccountSignInPath } from "@/features/account/routes";
import type { Locale } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import { getEntryPackPayPath } from "@/features/passes/entry-pack-checkout";

let enabled = false;
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({
    isCoworkPassesPageOpenAfterConnection: async () => enabled,
  })
);
mock.module("@/features/i18n/server/request-locale", () => ({
  runWithRequestLocale: (run: (locale: Locale) => unknown) => run("cs-CZ"),
}));
const ownedOrder = orderIdSchema.make("5413f44e-80ef-430e-9663-ddd7242a2ed0");
const entryPackOrders = await import(
  "@/features/passes/backend/entry-pack-order"
);
mock.module("@/features/passes/backend/entry-pack-order", () => ({
  ...entryPackOrders,
  readOwnedPassPurchaseOrderLocale: (orderId: OrderId) =>
    Effect.succeed(orderId === ownedOrder ? "en-US" : undefined),
}));
const workspaceEffect = await import("@/shared/backend/workspace-effect");
const runWorkspaceEffectOrElse = workspaceEffect.runWorkspaceEffectOrElse;
mock.module("@/shared/backend/workspace-effect", () => ({
  ...workspaceEffect,
  runWorkspaceEffectOrElse: (
    ...args: Parameters<typeof workspaceEffect.runWorkspaceEffectOrElse>
  ) =>
    args[0] === "passes.entry-pack-page"
      ? async () => ({
          buyer: { kind: "signed-out" },
          validity: {},
          draft: undefined,
          handoff: undefined,
          discountCodeEntryEnabled: false,
        })
      : runWorkspaceEffectOrElse(...args),
}));

const { default: EntryPackPage, generateMetadata } = await import("./page");
const searchParams = Promise.resolve({ tier: "open-space", size: "5" });

test("the localized checkout route returns not found while passes are off", async () => {
  await expect(EntryPackPage({ searchParams })).rejects.toThrow(
    "NEXT_HTTP_ERROR_FALLBACK;404"
  );
});

test.each([EntryPackPage, generateMetadata])(
  "while passes are off an owned order reaches private status in its issued locale (%p)",
  async (render) => {
    await expect(
      render({ searchParams: Promise.resolve({ order: ownedOrder }) })
    ).rejects.toHaveProperty(
      "digest",
      `NEXT_REDIRECT;replace;/en-US/reservation/status/${ownedOrder};307;`
    );
  }
);

test.each([EntryPackPage, generateMetadata])(
  "while passes are off unverified and malformed orders get the same 404 (%p)",
  async (render) => {
    for (const order of [
      undefined,
      crypto.randomUUID(),
      "malformed",
      [ownedOrder, ownedOrder],
    ]) {
      await expect(
        render({ searchParams: Promise.resolve({ order }) })
      ).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    }
  }
);

test("the localized checkout route opens when passes are available", async () => {
  enabled = true;
  expect(await EntryPackPage({ searchParams })).toBeTruthy();
});

test("a signed-out buyer returns to the same Entry pack Pay order after sign-in", async () => {
  enabled = true;
  const page = await EntryPackPage({
    searchParams: Promise.resolve({ order: ownedOrder, step: "pay" }),
  });
  const content = page.props.children;
  const callback = getAccountSignInPath(
    "cs-CZ",
    getEntryPackPayPath("cs-CZ", ownedOrder)
  );
  await expect(content.type(content.props)).rejects.toHaveProperty(
    "digest",
    `NEXT_REDIRECT;replace;${callback};307;`
  );
});
