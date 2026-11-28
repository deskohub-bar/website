import { expect, mock, test } from "bun:test";
import { requireElement } from "@/shared/testing/route-element.test-utils";

const AccountSectionPathCheck = mock(() => null);
const getAccountSectionMetadata = mock((locale: string, section: string) => ({
  title: `${locale}:${section}`,
}));

mock.module("@/features/account/components/account-section-route", () => ({
  AccountSectionPathCheck,
  getAccountSectionMetadata,
}));
mock.module("@/features/i18n/server/request-locale", () => ({
  runWithRequestLocale: (callback: (locale: "cs-CZ") => unknown) =>
    callback("cs-CZ"),
}));

const { default: CustomerAccountSectionPage, generateMetadata } = await import(
  "./page"
);

test("checks the section in the path", async () => {
  const route = requireElement<{ readonly section: Promise<string> }>(
    CustomerAccountSectionPage({
      params: Promise.resolve({ section: "security" }),
    })
  );

  expect(route.type).toBe(AccountSectionPathCheck);
  expect(await route.props.section).toBe("security");
});

test("titles the page after the section in the path", async () => {
  expect(
    await generateMetadata({ params: Promise.resolve({ section: "billing" }) })
  ).toEqual({ title: "cs-CZ:billing" });
});
