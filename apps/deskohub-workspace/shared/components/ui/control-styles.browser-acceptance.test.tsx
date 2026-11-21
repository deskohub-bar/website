import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  type Browser,
  chromium,
  expect as expectInBrowser,
  type Locator,
  type Page,
} from "@playwright/test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { compileWorkspaceAppStyles } from "@/shared/testing/workspace-app-styles.test-utils";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { ChoiceCard } from "./choice-card";
import { NavItem } from "./nav-item";
import { SegmentedControl } from "./segmented-control";
import { StatusBadge, type StatusTone } from "./status-badge";
import { UnstyledButton } from "./unstyled-button";

const chromiumAvailable = await playwrightChromiumAvailable();
let browser: Browser | undefined;
let appStyles = "";

beforeAll(async () => {
  if (!chromiumAvailable) return;
  appStyles = await compileWorkspaceAppStyles();
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

const withControls = async (
  controls: ReactNode,
  check: (page: Page) => Promise<void>
) => {
  if (!browser)
    throw new Error("The control styles browser has not been launched.");
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><main style="width: 300px">${renderToStaticMarkup(controls)}</main>`
    );
    await page.addStyleTag({
      content: `${appStyles}*{transition:none!important}`,
    });
    await check(page);
  } finally {
    await page.close();
  }
};

const computedColor = (page: Page, color: string) =>
  page.evaluate((value) => {
    const reference = document.createElement("span");
    reference.style.color = value;
    document.body.append(reference);
    try {
      return getComputedStyle(reference).color;
    } finally {
      reference.remove();
    }
  }, color);

const expectColor = async (
  locator: Locator,
  property: string,
  reference: string
) => {
  await expectInBrowser(locator).toHaveCSS(
    property,
    await computedColor(locator.page(), reference)
  );
};

const radiusOf = (locator: Locator) =>
  locator.evaluate((node) =>
    Number.parseFloat(getComputedStyle(node).borderTopLeftRadius)
  );

test.skipIf(!chromiumAvailable)(
  "primary buttons keep their fill and glow in the same colour family",
  async () => {
    await withControls(
      <>
        <Button className="mt-8">Reserve</Button>
        <Button tone="navy-blue">Navy</Button>
        <Button tone="danger">Danger</Button>
        <Button tone="chilean-fire">Chilean fire</Button>
      </>,
      async (page) => {
        const colors = [
          ["Reserve", "var(--brand-burned-orange)"],
          ["Navy", "var(--brand-navy-blue)"],
          ["Danger", "var(--color-red-800)"],
          ["Chilean fire", "var(--brand-chilean-fire)"],
        ] as const;
        for (const [name, color] of colors) {
          const button = page.getByRole("button", { name });
          const fill = await computedColor(page, color);
          const glow = await computedColor(
            page,
            `color-mix(in oklab, ${color} 60%, transparent)`
          );
          await expectInBrowser(button).toHaveCSS("background-color", fill);
          expect(
            await button.evaluate((node) => getComputedStyle(node).boxShadow)
          ).toContain(glow);
        }
        const reserve = page.getByRole("button", { name: "Reserve" });
        await expectInBrowser(reserve).toHaveCSS("height", "44px");
        await expectInBrowser(reserve).toHaveCSS("margin-top", "32px");
        expect(await radiusOf(reserve)).toBeGreaterThanOrEqual(22);
      }
    );
  }
);

test.skipIf(!chromiumAvailable)(
  "secondary and ghost treatments render their assigned text, edges, and fills",
  async () => {
    await withControls(
      <>
        <Button asChild tone="burned-orange" variant="secondary">
          <a href="/contact">Contact</a>
        </Button>
        <Button tone="burned-orange-ink" variant="secondary">
          Ink
        </Button>
        <Button tone="muted" variant="ghost">
          Muted
        </Button>
        <Button size="xs" tone="outline" variant="ghost">
          Outline
        </Button>
        <Button size="icon-sm" tone="tinted" variant="ghost">
          Tinted
        </Button>
      </>,
      async (page) => {
        const contact = page.getByRole("link", { name: "Contact" });
        const ink = page.getByRole("button", { name: "Ink" });
        const muted = page.getByRole("button", { name: "Muted" });
        const outline = page.getByRole("button", { name: "Outline" });
        const tinted = page.getByRole("button", { name: "Tinted" });

        await expectColor(contact, "color", "var(--brand-burned-orange)");
        await expectInBrowser(contact).not.toHaveCSS("box-shadow", "none");
        await expectColor(ink, "color", "var(--brand-burned-orange-ink)");
        await expectColor(
          ink,
          "border-top-color",
          "color-mix(in oklab, var(--brand-burned-orange) 25%, transparent)"
        );
        await ink.hover();
        await expectColor(
          ink,
          "border-top-color",
          "var(--brand-burned-orange)"
        );
        await expectColor(
          muted,
          "color",
          "color-mix(in oklab, var(--brand-navy-blue) 60%, transparent)"
        );
        await expectInBrowser(muted).toHaveCSS("box-shadow", "none");
        await expectInBrowser(outline).toHaveCSS("border-top-width", "1px");
        await expectColor(
          outline,
          "border-top-color",
          "color-mix(in oklab, var(--brand-navy-blue) 14%, transparent)"
        );
        await expectInBrowser(outline).toHaveCSS("height", "28px");
        await expectInBrowser(outline).toHaveCSS("box-shadow", "none");
        await expectColor(
          tinted,
          "background-color",
          "color-mix(in oklab, var(--brand-navy-blue) 5%, transparent)"
        );
        await expectInBrowser(tinted).toHaveCSS("border-top-width", "0px");
        await tinted.hover();
        await expectColor(
          tinted,
          "background-color",
          "color-mix(in oklab, var(--brand-burned-orange) 10%, transparent)"
        );
      }
    );
  }
);

test.skipIf(!chromiumAvailable)(
  "button sizes and variants fit the space their callers give them",
  async () => {
    await withControls(
      <>
        <Button caps fullWidth shape="rounded" size="xl" wrap>
          Pay for a workspace booking for your whole team
        </Button>
        <Button caps size="lg">
          Book
        </Button>
        <Button size="icon-sm" variant="ghost">
          Close
        </Button>
        <Button size="icon-xs" variant="ghost">
          Remove
        </Button>
        <Button variant="tile">Add payment card</Button>
        <Button variant="link">Use account details</Button>
      </>,
      async (page) => {
        const wrapped = page.getByRole("button", { name: /Pay for/ });
        await expectInBrowser(wrapped).toHaveCSS("width", "300px");
        await expectInBrowser(wrapped).toHaveCSS("white-space", "normal");
        await expectInBrowser(wrapped).toHaveCSS("text-transform", "uppercase");
        expect(
          await wrapped.evaluate((node) => node.clientHeight)
        ).toBeGreaterThan(52);
        await expectInBrowser(wrapped).toHaveCSS("border-radius", "12px");
        const book = page.getByRole("button", { name: "Book", exact: true });
        const spacing = (node: HTMLElement | SVGElement) => {
          const style = getComputedStyle(node);
          return (
            Number.parseFloat(style.letterSpacing) /
            Number.parseFloat(style.fontSize)
          );
        };
        expect(await wrapped.evaluate(spacing)).toBeCloseTo(0.18);
        expect(await book.evaluate(spacing)).toBeCloseTo(0.08);

        for (const [name, size] of [
          ["Close", 32],
          ["Remove", 24],
        ] as const) {
          const icon = page.getByRole("button", { name });
          await expectInBrowser(icon).toHaveCSS("width", `${size}px`);
          await expectInBrowser(icon).toHaveCSS("height", `${size}px`);
          await expectInBrowser(icon).toHaveCSS("padding-left", "0px");
          expect(await radiusOf(icon)).toBeGreaterThanOrEqual(size / 2);
        }
        const tile = page.getByRole("button", { name: "Add payment card" });
        await expectInBrowser(tile).toHaveCSS("border-top-style", "dashed");
        await expectInBrowser(tile).toHaveCSS("border-radius", "16px");
        await expectInBrowser(tile).toHaveCSS("flex-direction", "column");
        await expectInBrowser(tile).toHaveCSS("min-height", "144px");
        await expectInBrowser(tile).toHaveCSS("white-space", "normal");
        const link = page.getByRole("button", { name: "Use account details" });
        await expectInBrowser(link).toHaveCSS(
          "text-decoration-line",
          "underline"
        );
        await expectInBrowser(link).toHaveCSS("padding-left", "0px");
        await expectColor(link, "color", "var(--brand-burned-orange)");
        expect(await link.evaluate((node) => node.clientHeight)).toBeLessThan(
          44
        );
      }
    );
  }
);

test.skipIf(!chromiumAvailable)(
  "navigation items distinguish active positions and status badges distinguish tones",
  async () => {
    const badges: readonly [StatusTone, string][] = [
      ["attention", "var(--brand-burned-orange-ink)"],
      [
        "neutral",
        "color-mix(in oklab, var(--brand-navy-blue) 65%, transparent)",
      ],
      ["positive", "var(--brand-aquamarine-ink)"],
      ["progress", "var(--brand-sunset-yellow-ink)"],
    ];
    await withControls(
      <>
        <NavItem active>Profile</NavItem>
        <NavItem>Billing</NavItem>
        <NavItem active tone="danger">
          Danger zone
        </NavItem>
        <NavItem active asChild caps tone="inverse">
          <a href="/account">Account</a>
        </NavItem>
        <NavItem layout="icon" tone="inverse">
          Contact
        </NavItem>
        <NavItem asChild layout="step" tone="translucent">
          <a href="/reservation">Reservation</a>
        </NavItem>
        {badges.map(([tone]) => (
          <StatusBadge key={tone} tone={tone}>
            {tone}
          </StatusBadge>
        ))}
      </>,
      async (page) => {
        await expectInBrowser(
          page.getByRole("button", { name: "Profile" })
        ).toHaveCSS(
          "background-color",
          await computedColor(page, "var(--brand-navy-blue)")
        );
        await expectInBrowser(
          page.getByRole("button", { name: "Billing" })
        ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expectInBrowser(
          page.getByRole("button", { name: "Danger zone" })
        ).toHaveCSS("background-color", await computedColor(page, "#e71545"));
        const account = page.getByRole("link", { name: "Account" });
        await expectColor(account, "color", "var(--brand-sunset-yellow)");
        await expectInBrowser(account).toHaveCSS("text-transform", "uppercase");
        const contact = page.getByRole("button", { name: "Contact" });
        await expectColor(
          contact,
          "color",
          "color-mix(in oklab, white 80%, transparent)"
        );
        await expectInBrowser(contact).toHaveCSS("width", "40px");
        await expectInBrowser(contact).toHaveCSS("height", "40px");

        const step = page.getByRole("link", { name: "Reservation" });
        await expectInBrowser(step).toHaveCSS("display", "flex");
        await expectColor(
          step,
          "background-color",
          "color-mix(in oklab, white 7%, transparent)"
        );
        await step.hover();
        await expectColor(
          step,
          "background-color",
          "color-mix(in oklab, white 12%, transparent)"
        );
        await contact.focus();
        await page.keyboard.press("Tab");
        await expectInBrowser(step).toBeFocused();
        const ring = await step.evaluate(
          (node) => getComputedStyle(node).boxShadow
        );
        expect(ring).toContain(
          await computedColor(page, "var(--brand-burned-orange)")
        );
        expect(ring).not.toContain("inset");

        for (const [tone, color] of badges) {
          await expectInBrowser(
            page.getByText(tone, { exact: true })
          ).toHaveCSS("color", await computedColor(page, color));
        }
      }
    );
  }
);

test.skipIf(!chromiumAvailable)(
  "choice cards show selection and availability, and small segments take less space",
  async () => {
    await withControls(
      <>
        <ChoiceCard>
          <input defaultChecked type="checkbox" />
          Paid
        </ChoiceCard>
        <ChoiceCard>
          <Checkbox defaultChecked />
          Confirmed
        </ChoiceCard>
        <ChoiceCard>
          <input disabled type="checkbox" />
          Unavailable
        </ChoiceCard>
        <SegmentedControl
          label="Full"
          name="full"
          onValueChange={() => undefined}
          options={[{ label: "Full size", value: "full" }]}
          value="full"
        />
        <SegmentedControl
          label="Compact"
          name="compact"
          onValueChange={() => undefined}
          options={[{ label: "Compact size", value: "compact" }]}
          size="sm"
          value="compact"
        />
        <UnstyledButton>Next slide</UnstyledButton>
      </>,
      async (page) => {
        const accent = await computedColor(page, "var(--brand-burned-orange)");
        for (const text of ["Paid", "Confirmed"]) {
          await expectInBrowser(
            page.getByText(text, { exact: true })
          ).toHaveCSS("border-top-color", accent);
        }
        await expectInBrowser(
          page.getByRole("checkbox", { name: "Paid" })
        ).toHaveCSS("accent-color", accent);
        await expectInBrowser(page.getByText("Unavailable")).toHaveCSS(
          "cursor",
          "not-allowed"
        );
        await expectInBrowser(page.getByText("Compact size")).toHaveCSS(
          "height",
          "28px"
        );
        await expectInBrowser(page.getByText("Full size")).toHaveCSS(
          "height",
          "36px"
        );
        const unstyled = page.getByRole("button", { name: "Next slide" });
        await expectInBrowser(unstyled).toHaveCSS(
          "background-color",
          "rgba(0, 0, 0, 0)"
        );
        await expectInBrowser(unstyled).toHaveCSS("box-shadow", "none");
      }
    );
  }
);
