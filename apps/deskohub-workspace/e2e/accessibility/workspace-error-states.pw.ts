import { enablePreviewAccess } from "../preview-access";
import {
  auditedLocales,
  expectAxeClean,
  openSettledPage,
} from "./accessibility-audit";
import {
  localFixtureSkipReason,
  sandboxSkipReason,
  seededAccountSkipReason,
} from "./audit-target";
import { accessibilityTest as test } from "./fixtures";
import {
  openMissingReservationStatus,
  openSignIn,
  reservationForms,
  statusOutcomes,
  submitEmptyReservationForm,
  submitInvalidSignInEmail,
  withStatusOutcome,
} from "./page-states";

test.beforeEach(async ({ baseURL, context }) => {
  await enablePreviewAccess(context, baseURL);
});

for (const locale of auditedLocales) {
  for (const { family, path } of reservationForms) {
    test(`${locale} ${family} form with missing fields has no detectable accessibility violations`, async ({
      page,
    }, testInfo) => {
      test.skip(sandboxSkipReason !== undefined, sandboxSkipReason);
      await openSettledPage(page, `/${locale}${path}`);
      await submitEmptyReservationForm(page);
      await expectAxeClean(page, testInfo);
    });
  }

  test(`${locale} sign-in with an invalid email has no detectable accessibility violations`, async ({
    page,
  }, testInfo) => {
    await openSignIn(page, locale);
    await submitInvalidSignInEmail(page, locale);
    await expectAxeClean(page, testInfo);
  });

  for (const outcome of statusOutcomes) {
    test(`${locale} ${outcome} reservation status has no detectable accessibility violations`, async ({
      localDatabase,
      page,
    }, testInfo) => {
      test.skip(localFixtureSkipReason !== undefined, localFixtureSkipReason);
      await withStatusOutcome({ localDatabase, locale, outcome, page }, () =>
        expectAxeClean(page, testInfo)
      );
    });
  }
}

test.describe("missing reservation", () => {
  test.skip(seededAccountSkipReason !== undefined, seededAccountSkipReason);

  for (const locale of auditedLocales) {
    test(`${locale} not_found reservation status has no detectable accessibility violations`, async ({
      page,
      seededAccounts,
    }, testInfo) => {
      await openMissingReservationStatus({ locale, page, seededAccounts });
      await expectAxeClean(page, testInfo);
    });
  }
});
