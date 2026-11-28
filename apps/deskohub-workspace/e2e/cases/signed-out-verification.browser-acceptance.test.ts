import { afterAll, beforeAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { Effect } from "effect";
import { m } from "@/features/i18n";
import { playwrightChromiumAvailable } from "@/shared/testing/playwright-browser";
import { E2EBrowserSession } from "../browser-session";
import { workspaceE2ETimeouts } from "../timeouts";
import {
  isSignedOutContactStep,
  waitSignInAccepted,
} from "./signed-out-verification";

const chromiumAvailable = await playwrightChromiumAvailable();
const origin = "https://workspace.example.test";
let browser: Browser | undefined;
let page: Page | undefined;

beforeAll(async () => {
  if (!chromiumAvailable) return;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  // The prompt link resolves against the page's origin.
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({ body: "<html></html>", contentType: "text/html" })
  );
});

afterAll(async () => {
  await browser?.close();
});

const prompt = {
  signInLabel: "Sign in",
  signInPathname: "/en-US/auth/sign-in",
  submitSelector: "#reservation-submit",
  text: "Booked before? Sign in to fill in your details.",
};

const contactStep = ({
  field = (name: string) => `<input name="${name}" />`,
  promptHtml = `<p>Booked before?
    <a href="/en-US/auth/sign-in">Sign  in</a> to fill in your details.</p>`,
  submit = '<button id="reservation-submit">Book</button>',
} = {}) => `
  ${promptHtml}
  <form>
    ${field("name")}${field("email")}${field("phone")}
    ${submit}
  </form>`;

const isSignedOutOn = async (html: string) => {
  if (!page) throw new Error("Chromium is not running");
  await page.goto(`${origin}/en-US/reservation/cowork`);
  await page.setContent(html);
  return page.evaluate(isSignedOutContactStep, prompt);
};

test.skipIf(!chromiumAvailable)(
  "accepts an editable contact step with the sign-in prompt and its link",
  async () => {
    expect(await isSignedOutOn(contactStep())).toBe(true);
  }
);

test.skipIf(!chromiumAvailable)(
  "rejects a contact step that is read-only, unformed or missing the prompt link",
  async () => {
    const rejected = [
      contactStep({
        field: (name) =>
          name === "email"
            ? `<input name="${name}" readonly />`
            : `<input name="${name}" />`,
      }),
      contactStep({
        field: (name) =>
          name === "phone"
            ? `<input name="${name}" disabled />`
            : `<input name="${name}" />`,
      }),
      contactStep({
        field: (name) => (name === "name" ? "" : `<input name="${name}" />`),
      }),
      `${contactStep({ submit: "" })}<button id="reservation-submit">Book</button>`,
      contactStep({
        promptHtml: "<p>Booked before? Sign in to fill in your details.</p>",
      }),
      contactStep({
        promptHtml: `<p>Booked before? <a href="/en-US/account">Sign in</a> to fill in your details.</p>`,
      }),
      contactStep({
        promptHtml: `<p>Booked before? <a href="/en-US/auth/sign-in">Log in</a> to fill in your details.</p>`,
      }),
    ];
    for (const html of rejected) {
      expect(await isSignedOutOn(html)).toBe(false);
    }
  }
);

const locale = "en-US";
const codeTitle = m.accountSignInCodeTitle({}, { locale });
const acceptedTitle = m.accountSignInAcceptedTitle({}, { locale });
const code = "123456";
const codeInputId = "account-sign-in-code";
const verifyPath = "/en-US/auth/verify";
const returnPath = "/en-US/reservation/cowork";

const signInCodeBundle = async () => {
  const entry = join(import.meta.dir, "sign-in-code-fixture.tsx");
  const { outputs } = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
        import { createRoot } from "react-dom/client";
        import { SignInCodeStep } from "@/features/account/components/sign-in-code-step";

        createRoot(document.querySelector("#code-step")).render(
          <SignInCodeStep
            locale={${JSON.stringify(locale)}}
            requestedAt={Date.now()}
            verifiedMessage="Email verified"
            verifyCode={async (value) => value === ${JSON.stringify(code)} ? "verified" : "invalid"}
            onVerified={() => location.assign(${JSON.stringify(returnPath)})}
            requestNewEmail={async () => "sent"}
          />
        );
      `,
    },
    format: "iife",
    target: "browser",
  });
  const [bundle] = outputs;
  assert(bundle, "expected a browser bundle");
  return bundle.text();
};

const withVerificationPage = <A, E>(
  markup: string,
  drive: (session: E2EBrowserSession) => Effect.Effect<A, E>,
  script?: string
) => {
  if (!browser) throw new Error("Chromium is not running");
  return E2EBrowserSession.open({
    browser,
    id: "signed-out-verification",
    recordHar: false,
  }).pipe(
    Effect.tap((session) =>
      session.use("open local verification fixture", async (page) => {
        await page.route(`${origin}/**`, (route) => {
          const { pathname } = new URL(route.request().url());
          if (pathname === "/sign-in-code.js" && script !== undefined) {
            return route.fulfill({
              body: script,
              contentType: "text/javascript",
            });
          }
          return route.fulfill({
            body: pathname === verifyPath ? markup : "",
            contentType: "text/html",
          });
        });
        await page.goto(`${origin}${verifyPath}`);
      })
    ),
    Effect.flatMap(drive),
    Effect.scoped,
    Effect.runPromise
  );
};

const verificationConfig = {
  timeouts: {
    ...workspaceE2ETimeouts,
    browserAction: 1000,
    uiTransition: 2000,
  },
};

test.skipIf(!chromiumAvailable)(
  "the native OTP control accepts digits and returns to the reservation on completion",
  async () => {
    const script = await signInCodeBundle();
    await withVerificationPage(
      // The SDK positions its input over the slots, which use this Tailwind height.
      `<style>.h-14 { height: 3.5rem; }</style>
       <h1>${codeTitle}</h1><div id="code-step"></div><script src="/sign-in-code.js"></script>`,
      (session) =>
        Effect.gen(function* () {
          yield* session.use("wait for the rendered OTP field", (page) =>
            page.locator(`#${codeInputId}`).waitFor({ timeout: 2000 })
          );
          const confirmation = yield* waitSignInAccepted({
            config: verificationConfig,
            locale,
            session,
          });
          expect(confirmation).toBe("code");
          yield* session.use("enter the synthetic OTP", async (page) => {
            const input = page
              .locator(`#${codeInputId}`)
              .filter({ visible: true });
            await input.fill(code.slice(0, -1));
            expect(await input.inputValue()).toBe(code.slice(0, -1));
            expect(new URL(page.url()).pathname).toBe(verifyPath);
            await input.fill(code);
            await page.waitForURL(`${origin}${returnPath}`);
          });
        }),
      script
    );
  }
);

test.skipIf(!chromiumAvailable)(
  "the code heading and an unhydrated input do not make the OTP ready",
  async () => {
    const result = await withVerificationPage(
      `<h1>${codeTitle}</h1><input id="${codeInputId}">`,
      (session) =>
        Effect.result(
          waitSignInAccepted({ config: verificationConfig, locale, session })
        )
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { reason: "timeout" },
    });
  }
);

test.skipIf(!chromiumAvailable)(
  "the inbox notice is accepted without an OTP control",
  async () => {
    const confirmation = await withVerificationPage(
      `<h1>${acceptedTitle}</h1>`,
      (session) =>
        waitSignInAccepted({ config: verificationConfig, locale, session })
    );
    expect(confirmation).toBe("inbox");
  }
);
