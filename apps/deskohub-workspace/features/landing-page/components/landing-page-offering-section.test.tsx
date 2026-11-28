import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { prerender } from "react-dom/static";
import type { GlobalRelease } from "@/features/feature-flags/backend/global-release";
import { locales, m } from "@/features/i18n";
import {
  getCoworkReservationPath,
  getMeetingRoomReservationPath,
} from "@/features/reservation/routes";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";

const nextServer = await import("next/server");

mock.module("server-only", () => ({}));
mock.module("next/server", () => ({
  ...nextServer,
  connection: () => Promise.resolve(),
}));

const releasedFlags: Array<string> = [];
let passesRelease: GlobalRelease = "off";
const isCoworkPassesPageOpenAfterConnection = mock(async () => false);
mock.module("@/features/feature-flags/backend/global-release.server", () => ({
  loadGlobalRelease: async (flag: string) => {
    releasedFlags.push(flag);
    return passesRelease;
  },
}));
mock.module(
  "@/features/passes/backend/cowork-passes-release-gate.server",
  () => ({ isCoworkPassesPageOpenAfterConnection })
);

const isMeetingRoomPageEnabled = mock();
const isOfficePageEnabled = mock();
const isTeamTablePageEnabled = mock();
mock.module(
  "@/features/public-pages/backend/team-table-public-release.server",
  () => ({ isTeamTablePageEnabled })
);

const meetingRoomPageReleaseGate = await import(
  "@/features/meeting-room/backend/meeting-room-release-gate.server"
);
mock.module(
  "@/features/meeting-room/backend/meeting-room-release-gate.server",
  () => ({ ...meetingRoomPageReleaseGate, isMeetingRoomPageEnabled })
);
const officeReleaseGate = await import(
  "@/features/office/backend/office-release-gate.server"
);
mock.module("@/features/office/backend/office-release-gate.server", () => ({
  ...officeReleaseGate,
  isOfficePageEnabled,
}));

const { LandingPageOfferingSection } = await import(
  "./landing-page-offering-section"
);

const renderSection = async (
  locale: (typeof locales)[number],
  flags: {
    readonly meetingRoomPage: boolean;
    readonly officePage: boolean;
    readonly teamTablePage?: boolean;
  }
) => {
  isMeetingRoomPageEnabled.mockResolvedValue(flags.meetingRoomPage);
  isOfficePageEnabled.mockResolvedValue(flags.officePage);
  isTeamTablePageEnabled.mockResolvedValue(flags.teamTablePage ?? false);
  const { prelude } = await prerender(
    await LandingPageOfferingSection({ locale })
  );
  const container = document.createElement("div");
  container.innerHTML = await new Response(prelude).text();
  return container;
};

/** Links that carry the pass product marks. */
const passLinks = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("a"))
    .filter((link) => link.querySelector('[aria-hidden="true"] svg'))
    .map((link) => link.getAttribute("href"));

const hrefs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("a"), (link) =>
    link.getAttribute("href")
  );

test("links the localized Team Table booking page only while released", async () => {
  const closed = { meetingRoomPage: false, officePage: false };
  const route = "/en-US/reservation/table";

  expect(hrefs(await renderSection("en-US", closed))).not.toContain(route);
  const open = await renderSection("en-US", { ...closed, teamTablePage: true });
  expect(hrefs(open)).toContain(route);
  expect(open.textContent).toContain("Book a Team Table");
});

beforeAll(registerWorkspaceComponentTestEnv);
afterAll(unregisterWorkspaceComponentTestEnv);

describe.each(locales)("LandingPageOfferingSection in %s", (locale) => {
  beforeEach(() => {
    isMeetingRoomPageEnabled.mockReset();
    isOfficePageEnabled.mockReset();
    releasedFlags.length = 0;
    passesRelease = "off";
    isCoworkPassesPageOpenAfterConnection.mockReset();
    isCoworkPassesPageOpenAfterConnection.mockResolvedValue(false);
  });

  test("links each offer to its booking or detail page", async () => {
    const container = await renderSection(locale, {
      meetingRoomPage: true,
      officePage: true,
    });

    expect(hrefs(container)).toEqual([
      `/${locale}/pricing`,
      getCoworkReservationPath(locale),
      `/${locale}/coworking`,
      getMeetingRoomReservationPath(locale),
      `/${locale}/meeting-room`,
      `/${locale}/ttrpg-room`,
      `/${locale}/contact`,
    ]);
  });

  test("leaves out the meeting room page link while that page is off", async () => {
    const container = await renderSection(locale, {
      meetingRoomPage: false,
      officePage: true,
    });

    expect(hrefs(container)).not.toContain(`/${locale}/meeting-room`);
    expect(hrefs(container)).toContain(getMeetingRoomReservationPath(locale));
  });

  test("mentions private offices only while the office page is off", async () => {
    const offices = m.landingOfferingOffices({}, { locale });
    const withOfficePage = await renderSection(locale, {
      meetingRoomPage: true,
      officePage: true,
    });
    const withoutOfficePage = await renderSection(locale, {
      meetingRoomPage: true,
      officePage: false,
    });

    expect(withOfficePage.textContent).not.toContain(offices);
    expect(withoutOfficePage.textContent).toContain(offices);
  });

  test("links packs and passes to Pricing while cowork passes are released", async () => {
    passesRelease = "on";
    const container = await renderSection(locale, {
      meetingRoomPage: true,
      officePage: true,
    });

    expect(passLinks(container)).toEqual([`/${locale}/pricing`]);
    expect(hrefs(container)).toContain(`/${locale}/coworking`);
    expect(releasedFlags).toEqual(["cowork_passes"]);
  });

  test("leaves out the packs and passes link while cowork passes are off", async () => {
    const container = await renderSection(locale, {
      meetingRoomPage: true,
      officePage: true,
    });

    expect(passLinks(container)).toEqual([]);
    expect(isCoworkPassesPageOpenAfterConnection).not.toHaveBeenCalled();
  });
});

describe("LandingPageOfferingSection while the cowork passes release varies", () => {
  test("follows the visitor's cowork passes gate", async () => {
    passesRelease = "undecided";
    const flags = { meetingRoomPage: true, officePage: true };
    isCoworkPassesPageOpenAfterConnection.mockResolvedValue(false);
    const closed = await renderSection("en-US", flags);
    isCoworkPassesPageOpenAfterConnection.mockResolvedValue(true);
    const open = await renderSection("en-US", flags);

    expect(passLinks(closed)).toEqual([]);
    expect(passLinks(open)).toEqual(["/en-US/pricing"]);
  });
});
