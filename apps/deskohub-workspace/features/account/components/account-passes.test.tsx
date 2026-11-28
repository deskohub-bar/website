import { afterAll, beforeAll, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { within } from "@testing-library/react";
import { renderToReadableStream } from "react-dom/server";
import type {
  AccountBoughtPass,
  AccountEntryPack,
} from "@/features/account/account-passes.server";
import type { AccountUnlimitedPass } from "@/features/account/account-unlimited-passes.server";
import { m } from "@/features/i18n";
import { orderIdSchema } from "@/features/order";
import "@/shared/testing/workspace-component-module-mocks";
import { UnsavedChangesProvider } from "@/shared/components/unsaved-changes-guard";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { maskEmailAddress } from "@/shared/utils";
import { AccountPassesPanel } from "./account-passes";

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);

test("links to both purchases in the localized packs and memberships header", async () => {
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="cs-CZ"
          packs={Promise.resolve({ held: [], boughtForOthers: [] })}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  const document = new DOMParser().parseFromString(markup, "text/html");
  const header = document.querySelector("header");
  if (!header) throw new Error("Missing packs and memberships header");
  const actions = within(header);

  expect(
    actions.getByRole("heading", { name: "Balíčky a členství" })
  ).toBeTruthy();
  expect(
    actions
      .getByRole("link", { name: "Koupit balíček vstupů" })
      .getAttribute("href")
  ).toBe("/cs-CZ/passes/entry-pack");
  expect(
    actions
      .getByRole("link", { name: "Kup si neomezené členství" })
      .getAttribute("href")
  ).toBe("/cs-CZ/passes/unlimited");
});

test("shows the purchase date and balance, and links only the bookable pack", async () => {
  const syntheticPackId = "fixture-holder-pack";
  const openPackOrderId = orderIdSchema.make(crypto.randomUUID());
  const expiredPackOrderId = orderIdSchema.make(crypto.randomUUID());
  const openPackStatusPath = `/en-US/reservation/status/${openPackOrderId}`;
  const expiredPackStatusPath = `/en-US/reservation/status/${expiredPackOrderId}`;
  const openPack: AccountEntryPack = {
    position: 0,
    tier: "Open Space",
    entryCount: 5,
    entriesLeft: 3,
    boughtOn: "Oct 31, 2026",
    lastUsableDay: "Dec 30, 2026",
    status: "active",
    bookPath: `/en-US/reservation/cowork?pass=${syntheticPackId}`,
    statusPath: openPackStatusPath,
  };
  const expiredPack: AccountEntryPack = {
    position: 1,
    tier: "Reserved Desk",
    entryCount: 10,
    entriesLeft: 4,
    boughtOn: "May 31, 2026",
    lastUsableDay: "Aug 30, 2026",
    status: "expired",
    statusPath: expiredPackStatusPath,
  };
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve({
            held: [openPack, expiredPack],
            boughtForOthers: [],
          })}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain("Bought Oct 31, 2026");
  expect(markup).toContain("3 of 5 entries left");
  expect(markup).toContain("4 of 10 entries left");
  expect(markup).toContain("Expired");
  expect(markup).toContain(`href="${openPack.bookPath}"`);
  expect(markup).toContain(`href="${openPackStatusPath}"`);
  expect(markup).toContain(`href="${expiredPackStatusPath}"`);
  expect(markup.match(/View order status/g)).toHaveLength(2);
  expect(markup.match(/Book a date/g)).toHaveLength(1);
  expect(markup.match(new RegExp(syntheticPackId, "g"))).toHaveLength(1);
});

test("presents the buyer's order separately from passes they can use", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const unavailableOrderId = orderIdSchema.make(crypto.randomUUID());
  const statusPath = `/en-US/reservation/status/${orderId}`;
  const maskedHolderEmail = maskEmailAddress(testEmailAddress("alice"));
  const gift: AccountBoughtPass = {
    orderId,
    statusPath,
    tier: "Open Space",
    product: "entry-pack",
    entryCount: 5,
    maskedHolderEmail,
    invitation: "sent",
    claimed: false,
    canResend: true,
  };
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve({
            held: [],
            boughtForOthers: [
              gift,
              {
                orderId: unavailableOrderId,
                statusPath: `/en-US/reservation/status/${unavailableOrderId}`,
                tier: "Reserved Desk",
                product: "unlimited",
                invitation: "sent",
                claimed: false,
              },
            ],
          })}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain("Bought for others");
  expect(markup).toContain(`For ${maskedHolderEmail}`);
  expect(markup).toContain(`href="${statusPath}"`);
  expect(markup).toContain("Invitation sent");
  expect(markup).toContain("Not claimed yet");
  expect(markup).toContain("Unlimited membership</h4>");
  expect(markup.match(/Resend invitation/g)).toHaveLength(1);
  expect(markup).not.toContain("entries left");
  expect(markup).not.toContain("Book a date");
  expect(markup).not.toContain("/reservation/access/");
  expect(markup).not.toContain("Day 1 of 30");
  expect(markup).not.toContain(m.accountPassesEmpty({}, { locale: "en-US" }));
});

test("renders a held Unlimited membership with its assigned desk and purchase date", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const pass: AccountUnlimitedPass = {
    orderId,
    tier: "Reserved Desk",
    boughtOn: "Oct 31, 2026",
    boughtForYou: true,
    period: "Nov 10 – Dec 9, 2026",
    seating: { kind: "assigned", name: "Desk 14" },
    status: "active",
    day: 8,
    totalDays: 30,
    daysLeft: 23,
    accessPath: `/en-US/reservation/access/${orderId}`,
  };
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve({ held: [], boughtForOthers: [] })}
          unlimitedPasses={[pass]}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain("Day 8 of 30");
  expect(markup).toContain("23 days left, including today");
  expect(markup).toContain("Desk 14");
  expect(markup).toContain("Bought Oct 31, 2026");
  expect(markup).toContain(`href="${pass.accessPath}"`);
  expect(markup).not.toContain("View order status");
});

test("links a buyer's Unlimited membership cards to their order status pages", async () => {
  const activeOrderId = orderIdSchema.make(crypto.randomUUID());
  const upcomingOrderId = orderIdSchema.make(crypto.randomUUID());
  const activeStatusPath = `/en-US/reservation/status/${activeOrderId}`;
  const upcomingStatusPath = `/en-US/reservation/status/${upcomingOrderId}`;
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve({ held: [], boughtForOthers: [] })}
          unlimitedPasses={[
            {
              orderId: activeOrderId,
              tier: "Open Space",
              boughtOn: "Oct 31, 2026",
              boughtForYou: false,
              period: "Nov 10 – Dec 9, 2026",
              seating: { kind: "shared" },
              statusPath: activeStatusPath,
              status: "active",
              day: 8,
              totalDays: 30,
              daysLeft: 23,
              accessPath: `/en-US/reservation/access/${activeOrderId}`,
            },
            {
              orderId: upcomingOrderId,
              tier: "Reserved Desk",
              boughtOn: "Nov 20, 2026",
              boughtForYou: false,
              period: "Dec 10, 2026 – Jan 8, 2027",
              seating: { kind: "assigned", name: "Desk 7" },
              statusPath: upcomingStatusPath,
              status: "upcoming",
              startsOn: "Dec 10, 2026",
            },
          ]}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain(`href="${activeStatusPath}"`);
  expect(markup).toContain(`href="${upcomingStatusPath}"`);
  expect(markup.match(/View order status/g)).toHaveLength(2);
});

test("uses the adjusted Unlimited term for the day label and remaining meter segments", async () => {
  const orderId = orderIdSchema.make(crypto.randomUUID());
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve({ held: [], boughtForOthers: [] })}
          unlimitedPasses={[
            {
              orderId,
              tier: "Open Space",
              boughtForYou: false,
              period: "Nov 1 – Dec 2, 2026",
              seating: { kind: "shared" },
              status: "active",
              day: 31,
              totalDays: 32,
              daysLeft: 2,
              accessPath: `/en-US/reservation/access/${orderId}`,
            },
          ]}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain("Day 31 of 32");
  expect(markup).toContain("2 days left, including today");
  expect(markup.match(/min-w-0 flex-1 rounded-full/g)).toHaveLength(32);
});

test("shows a lookup failure when Entry Packs loaded empty and Unlimited did not load", async () => {
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve({ held: [], boughtForOthers: [] })}
          unlimitedPasses="unavailable"
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain(
    "Your Unlimited memberships couldn’t be loaded right now."
  );
  expect(markup).not.toContain(m.accountPassesEmpty({}, { locale: "en-US" }));
});

test("shows generic gift attribution when there is no buyer name", async () => {
  const markup = await new Response(
    await renderToReadableStream(
      <UnsavedChangesProvider>
        <AccountPassesPanel
          locale="en-US"
          packs={Promise.resolve({
            boughtForOthers: [],
            held: [
              {
                position: 0,
                tier: "Reserved Desk",
                entryCount: 5,
                entriesLeft: 5,
                boughtOn: "Oct 31, 2026",
                lastUsableDay: "Dec 30, 2026",
                status: "active",
                gift: { orderId: orderIdSchema.make(crypto.randomUUID()) },
              },
            ],
          })}
        />
      </UnsavedChangesProvider>
    )
  ).text();

  expect(markup).toContain("Bought for you");
  expect(markup).not.toContain("Bought for you by");
  expect(markup).not.toContain("Book a date");
  expect(markup).not.toContain("View order status");
});
