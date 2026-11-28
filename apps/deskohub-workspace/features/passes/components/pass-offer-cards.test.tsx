import { afterAll, afterEach, expect, test } from "bun:test";
import { m } from "@/features/i18n";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

registerWorkspaceComponentTestEnv();
const { cleanup, render } = await import("@testing-library/react");
const { EntryPackOfferCard, UnlimitedPassOfferCard } = await import(
  "./pass-offer-cards"
);
const { PassPurchaseOffers } = await import("./pass-purchase-offers");

afterEach(cleanup);
afterAll(unregisterWorkspaceComponentTestEnv);

const locale = "en-US";

test("the Entry pack ticket is one link with its stub and both watermark halves", () => {
  const view = render(
    <EntryPackOfferCard
      href="/en-US/passes/entry-pack?tier=open-space"
      locale={locale}
      tier="open-space"
    />
  );
  const link = view.getByRole("link", {
    name: m.entryPackOfferLabel(
      { tier: m.passTierOpenSpace({}, { locale }) },
      { locale }
    ),
  });
  expect(link.getAttribute("href")).toBe(
    "/en-US/passes/entry-pack?tier=open-space"
  );
  expect(link.querySelector("h3")?.textContent).toBe(
    m.passEntryPack({}, { locale })
  );
  // The stub offers every pack size.
  expect(link.textContent).toContain(
    m.entryPackOfferSizes({ smaller: 5, larger: 10 }, { locale })
  );
  const body = link.querySelector<HTMLElement>('[data-watermark="body"]');
  const stub = link.querySelector<HTMLElement>('[data-watermark="stub"]');
  expect(body?.style.mixBlendMode).toBe("darken");
  expect(body?.style.opacity).toBe("0.78");
  expect(stub?.style.mixBlendMode).toBe("soft-light");
  expect(body?.closest('[aria-hidden="true"]')).not.toBeNull();
});

test("the Unlimited credential shows its issuer, foil, mark and the expiry it describes", () => {
  const view = render(
    <UnlimitedPassOfferCard
      expiresOn={Temporal.PlainDate.from("2099-08-29")}
      expiryId="expiry"
      href="/en-US/passes/unlimited?tier=reserved-desk"
      locale={locale}
      tier="reserved-desk"
    />
  );
  const link = view.getByRole("link", {
    name: m.unlimitedPassOfferLabel(
      { tier: m.passTierReservedDesk({}, { locale }) },
      { locale }
    ),
  });
  expect(link.getAttribute("href")).toBe(
    "/en-US/passes/unlimited?tier=reserved-desk"
  );
  expect(link.textContent).toContain(m.workspaceTitle({}, { locale }));
  expect(link.textContent).toContain(m.passMembership({}, { locale }));
  expect(link.querySelector("[data-foil-stripe]")).not.toBeNull();
  expect(link.querySelector("[data-workspace-mark]")).not.toBeNull();
  const time = link.querySelector("time");
  expect(time?.getAttribute("dateTime")).toBe("2099-08-29");
  expect(time?.closest("#expiry")).not.toBeNull();
  expect(link.getAttribute("aria-describedby")).toBe("expiry");
});

test("the Unlimited tagline follows the tier", () => {
  const tagline = (tier: "open-space" | "reserved-desk-workstation") => {
    const view = render(
      <UnlimitedPassOfferCard
        expiresOn={Temporal.PlainDate.from("2099-08-29")}
        expiryId={`expiry-${tier}`}
        href="/en-US/passes/unlimited"
        locale={locale}
        tier={tier}
      />
    );
    const text = view.container.querySelector("header p")?.textContent;
    cleanup();
    return text;
  };
  expect(tagline("open-space")).toBe(
    m.unlimitedPassOfferTaglineOpenSpace({}, { locale })
  );
  expect(tagline("reserved-desk-workstation")).toBe(
    m.unlimitedPassOfferTaglineReservedDesk({}, { locale })
  );
});

test("the booking offers link both products from the draft and date the pass from today without a start date", () => {
  const view = render(
    <PassPurchaseOffers
      draft={{ tier: "open-space", coffee: true }}
      locale={locale}
      today="2026-11-22"
    />
  );
  const section = view
    .getByRole("heading", { name: m.passPurchaseOffersHeading({}, { locale }) })
    .closest("section");
  const hrefs = [...(section?.querySelectorAll("a") ?? [])].map((link) =>
    link.getAttribute("href")
  );
  expect(hrefs).toEqual([
    "/en-US/passes/entry-pack?tier=open-space",
    "/en-US/passes/unlimited?tier=open-space&coffee=true",
  ]);
  expect(section?.querySelector("time")?.getAttribute("dateTime")).toBe(
    "2026-12-22"
  );
});
