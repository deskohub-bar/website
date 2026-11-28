import { afterAll, afterEach, expect, mock, test } from "bun:test";
import type { Locale } from "@/features/i18n";
import { type OrderId, orderIdSchema } from "@/features/order";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

registerWorkspaceComponentTestEnv();
const { cleanup, fireEvent, render } = await import("@testing-library/react");

let pathname = "/en-US/account/passes";
let search = new URLSearchParams();
const refresh = mock(() => undefined);
const resend = mock(
  async (
    _orderId: OrderId,
    _locale: Locale
  ): Promise<"queued" | "unavailable"> => "queued"
);
const navigation = await import("next/navigation");
mock.module("next/navigation", () => ({
  ...navigation,
  usePathname: () => pathname,
  useRouter: () => ({ refresh }),
  useSearchParams: () => search,
}));
mock.module("@/features/passes/entry-pack-gift-actions", () => ({
  resendEntryPackInvitation: resend,
}));
const { FocusedGiftPassCard, GiftInvitationResend } = await import(
  "./account-pass-gift"
);

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

test("focuses only the holder card named in the Passes URL", () => {
  const gifted = orderIdSchema.make(crypto.randomUUID());
  const unrelated = orderIdSchema.make(crypto.randomUUID());
  const card = () => (
    <FocusedGiftPassCard
      className="rounded-2xl border"
      locale="en-US"
      orderId={gifted}
      titleId="gift-card-title"
    >
      <h4 id="gift-card-title">Reserved Desk</h4>
    </FocusedGiftPassCard>
  );
  search = new URLSearchParams({ pass: unrelated });
  const view = render(card());
  const article = view.getByRole("article", { name: "Reserved Desk" });
  expect(article.hasAttribute("tabindex")).toBe(false);

  search = new URLSearchParams({ pass: gifted });
  view.rerender(card());
  expect(document.activeElement).toBe(article);
  expect(article.tabIndex).toBe(-1);

  pathname = "/en-US/account/profile";
  view.rerender(card());
  expect(article.hasAttribute("tabindex")).toBe(false);
});

test("shows pending then queued state when the buyer requests a resend", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const result = Promise.withResolvers<"queued">();
  resend.mockReturnValueOnce(result.promise);
  const view = render(
    <GiftInvitationResend canResend locale="en-US" orderId={orderId} />
  );
  const form = view
    .getByRole("button", { name: "Resend invitation" })
    .closest("form");
  if (!form) throw new Error("Missing resend form");
  fireEvent.submit(form);

  const pending = await view.findByRole("button", {
    name: "Resending invitation…",
  });
  expect(pending.hasAttribute("disabled")).toBe(true);
  expect(resend).toHaveBeenCalledWith(orderId, "en-US");

  result.resolve("queued");
  await view.findByText("Invitation queued for sending.");
  expect(refresh).toHaveBeenCalledTimes(1);
  view.rerender(
    <GiftInvitationResend canResend={false} locale="en-US" orderId={orderId} />
  );
  expect(view.getByRole("status").textContent).toBe(
    "Invitation queued for sending."
  );
});
