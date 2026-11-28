import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import assert from "node:assert/strict";
import type {
  AutomationDetail,
  AutomationDryRun,
} from "@deskohub/workspace-admin-api";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { m } from "@/features/administration/i18n";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import {
  type WorkspaceActionExecute,
  workspaceUseAction,
} from "@/shared/testing/workspace-component-module-mocks";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import { describeCampaignOperationFailure } from "../../campaign-operation-failure";
import {
  activeVersionFixture,
  automatedCampaignFixture,
  automationDetailFixture,
  fixtureCampaignId,
} from "./automation-detail.test-utils";
import { automationDryRunFixture } from "./automation-dry-run.test-utils";
import { dryRunJobFailureCopy } from "./automation-failure-copy";

const locale = "en-US";
/** The settled dry run job the page reads, by its status alone. */
type SettledDryRun = Pick<AutomationDryRun, "status" | "errorCode">;
const loadAutomationDryRun = mock(
  async (): Promise<SettledDryRun | AutomationDryRun | undefined> => undefined
);

mock.module("@/features/i18n/server/request-locale", () => ({
  getRequestLocale: async () => locale,
}));
mock.module("./automation-dry-run.server", () => ({ loadAutomationDryRun }));
mock.module("./automation-dry-run-polling", () => ({
  AutomationDryRunPolling: () => <span data-testid="dry-run-polling" />,
}));
mock.module("../../campaign-operations.actions", () => ({
  runCampaignOperation: mock(),
}));

registerWorkspaceComponentTestEnv();

const { AutomationPreviewPage } = await import("./automation-preview-page");

const execute = mock<WorkspaceActionExecute>();
const label = {
  activate: m.emailAutomationActivationActivate({}, { locale }),
  publish: m.emailAutomationActivationPublish({}, { locale }),
  run: m.emailAutomationActivationRun({}, { locale }),
  runAgain: m.emailAutomationActivationRunAgain({}, { locale }),
};

const renderPage = async (automation: AutomationDetail) =>
  render(
    <RouteLocaleProvider locale={locale}>
      {
        await AutomationPreviewPage({
          automated: {
            campaign: automatedCampaignFixture(),
            automation,
          },
        })
      }
    </RouteLocaleProvider>
  );

const controls = (view: Awaited<ReturnType<typeof renderPage>>) => ({
  activate: view.queryByRole("button", { name: label.activate }),
  publish: view.queryByRole("button", { name: label.publish }),
  run: view.queryByRole("button", { name: label.run }),
  runAgain: view.queryByRole("button", { name: label.runAgain }),
  progress: view.queryByRole("progressbar"),
  polling: view.queryByTestId("dry-run-polling"),
});

const ready = { _tag: "Ready", previewId: "preview-ready", draftHash: "hash" };
const running = {
  _tag: "PreviewRunning",
  previewId: "preview-running",
  unitsDone: 3,
  unitsTotal: 10,
};

describe("AutomationPreviewPage activation gate", () => {
  beforeEach(() => {
    execute.mockClear();
    loadAutomationDryRun.mockReset();
    loadAutomationDryRun.mockImplementation(async () => undefined);
    workspaceUseAction.mockReset();
    workspaceUseAction.mockImplementation(() => ({
      execute,
      isExecuting: false,
    }));
  });
  afterEach(() => cleanup());
  afterAll(() => unregisterWorkspaceComponentTestEnv());

  test("asks for a dry run before Activate", async () => {
    const view = await renderPage(automationDetailFixture());
    const shown = controls(view);

    expect(shown.run).not.toBeNull();
    expect(shown.activate?.hasAttribute("disabled")).toBe(true);
    expect(shown.progress).toBeNull();
    expect(shown.polling).toBeNull();
  });

  test("shows a running dry run's progress and polls it, with Activate disabled", async () => {
    const view = await renderPage(
      automationDetailFixture({ activation: running })
    );
    const shown = controls(view);

    expect(shown.progress?.getAttribute("aria-valuenow")).toBe("3");
    expect(shown.progress?.getAttribute("aria-valuemax")).toBe("10");
    expect(shown.polling).not.toBeNull();
    expect(shown.run).toBeNull();
    expect(shown.activate?.hasAttribute("disabled")).toBe(true);
  });

  test("enables Activate for the ready dry run, and only then", async () => {
    const view = await renderPage(
      automationDetailFixture({ activation: ready })
    );
    const shown = controls(view);

    expect(shown.activate?.hasAttribute("disabled")).toBe(false);
    expect(shown.run).toBeNull();
    expect(shown.polling).toBeNull();
    expect(view.getByRole("status").textContent).not.toBe("");

    fireEvent.click(view.getByRole("button", { name: label.activate }));
    expect(execute).toHaveBeenCalledWith({
      operation: "activateAutomation",
      input: { campaignId: fixtureCampaignId, previewId: "preview-ready" },
    });
  });

  test("labels an expired pass forecast as past, with Activate disabled", async () => {
    const asOf = "2020-10-05T08:00:00.000Z";
    loadAutomationDryRun.mockImplementation(async () =>
      automationDryRunFixture({ kind: "schedule", asOf, nextFires: [asOf] })
    );
    const view = await renderPage(automationDetailFixture());

    expect(
      view.getByText(m.emailAutomationActivationPastFireTitle({}, { locale }))
    ).not.toBeNull();
    expect(controls(view).activate?.hasAttribute("disabled")).toBe(true);
  });

  test.each([
    ["still ahead", { milliseconds: -1 }, true],
    ["reached", { milliseconds: 0 }, false],
  ] as const)(
    "gates a Ready pass forecast whose fire is %s once the report loads",
    async (_, offset, current) => {
      const asOf = "2030-10-05T08:00:00.000Z";
      const fire = Temporal.Instant.from(asOf);
      // The port answered Ready a second before the fire.
      const clock = spyOn(Temporal.Now, "instant").mockReturnValue(
        fire.subtract({ seconds: 1 })
      );
      try {
        loadAutomationDryRun.mockImplementation(async () => {
          clock.mockReturnValue(fire.add(offset));
          return automationDryRunFixture({
            kind: "schedule",
            asOf,
            nextFires: [asOf],
          });
        });
        const view = await renderPage(
          automationDetailFixture({
            activation: ready,
            trigger: { kind: "entry-pack-expiring", frequency: null },
          })
        );
        const shown = controls(view);

        expect(shown.activate?.hasAttribute("disabled")).toBe(!current);
        expect(shown.runAgain !== null).toBe(current);
        expect(shown.run !== null).toBe(!current);
        expect(
          view.queryByText(m.emailAutomationActivationReady({}, { locale })) !==
            null
        ).toBe(current);
        expect(
          view.queryByText(
            m.emailAutomationActivationPastFireTitle({}, { locale })
          ) !== null
        ).toBe(!current);
      } finally {
        clock.mockRestore();
      }
    }
  );

  test("follows the port's readiness rather than judging the flow itself", async () => {
    const withoutFlow = await renderPage(
      automationDetailFixture({ flow: null, trigger: null, activation: ready })
    );
    expect(controls(withoutFlow).activate?.hasAttribute("disabled")).toBe(
      false
    );
    cleanup();

    const withFlow = await renderPage(automationDetailFixture());
    expect(controls(withFlow).activate?.hasAttribute("disabled")).toBe(true);
  });

  test("publishes changes to a live automation", async () => {
    const view = await renderPage(
      automationDetailFixture({
        status: "active",
        activeVersion: activeVersionFixture(),
        versionCount: 1,
        pendingChanges: true,
        activation: ready,
      })
    );
    const shown = controls(view);

    expect(shown.activate).toBeNull();
    expect(shown.publish?.hasAttribute("disabled")).toBe(false);
  });

  test("offers neither a dry run nor Activate once the working copy is live", async () => {
    const view = await renderPage(
      automationDetailFixture({
        status: "active",
        activeVersion: activeVersionFixture(),
        versionCount: 1,
        activation: { _tag: "Published" },
      })
    );

    expect(view.queryAllByRole("button")).toHaveLength(0);
  });

  test("offers no actions on an archived automation", async () => {
    const view = await renderPage(
      automationDetailFixture({
        status: "archived",
        archivedAt: "2026-10-04T08:00:00.000Z",
        activation: ready,
      })
    );

    expect(view.queryAllByRole("button")).toHaveLength(0);
  });

  test.each(["failed", "superseded"] as const)(
    "offers another dry run after the job %s, without Activate",
    async (status) => {
      loadAutomationDryRun.mockImplementation(async () => ({
        status,
        errorCode: "preview-stalled",
      }));
      const view = await renderPage(
        automationDetailFixture({ activation: running })
      );
      const shown = controls(view);

      expect(shown.runAgain).not.toBeNull();
      expect(shown.activate?.hasAttribute("disabled")).toBe(true);
      expect(shown.progress).toBeNull();
      expect(shown.polling).toBeNull();
    }
  );

  test.each([
    [
      "schedule",
      {
        kind: "schedule",
        frequency: { maxFiresPerHour: 1, firesMoreThanHourly: false },
      },
      m.emailAutomationActivationExplainSchedule,
    ],
    [
      "event",
      { kind: "account-created", frequency: null },
      m.emailAutomationActivationExplainReplay,
    ],
    [
      "pass reminder",
      { kind: "entry-pack-expiring", frequency: null },
      m.emailAutomationActivationExplainPassForecast,
    ],
  ] as const)(
    "explains what a %s trigger's dry run evaluates",
    async (_, trigger, explanation) => {
      const view = await renderPage(automationDetailFixture({ trigger }));

      expect(view.getByText(explanation({}, { locale }))).not.toBeNull();
    }
  );

  test("explains why the failed job stopped", async () => {
    loadAutomationDryRun.mockImplementation(async () => ({
      status: "failed",
      errorCode: null,
    }));
    const view = await renderPage(
      automationDetailFixture({ activation: running })
    );

    expect(
      view.getByText(m.emailAutomationActivationJobFailed({}, { locale }))
    ).not.toBeNull();
    expect(
      view.getByText(
        describeCampaignOperationFailure(
          { code: "" },
          dryRunJobFailureCopy,
          locale
        )
      )
    ).not.toBeNull();
    expect(
      view.queryByText(m.emailAutomationActivationJobSuperseded({}, { locale }))
    ).toBeNull();
  });

  test("allows refreshing a completed pass reminder forecast", async () => {
    const view = await renderPage(
      automationDetailFixture({
        activation: ready,
        trigger: { kind: "entry-pack-expiring", frequency: null },
      })
    );
    expect(controls(view).runAgain).not.toBeNull();
  });

  test("says a newer job superseded this one", async () => {
    loadAutomationDryRun.mockImplementation(async () => ({
      status: "superseded",
      errorCode: null,
    }));
    const view = await renderPage(automationDetailFixture());

    expect(
      view.getByText(m.emailAutomationActivationJobSuperseded({}, { locale }))
    ).not.toBeNull();
    expect(
      view.queryByText(m.emailAutomationActivationJobFailed({}, { locale }))
    ).toBeNull();
  });

  test("shows a completed dry run's results, and a settled one's not", async () => {
    const resultsTitle = m.emailAutomationActivationResultsTitle(
      {},
      { locale }
    );
    loadAutomationDryRun.mockImplementation(async () =>
      automationDryRunFixture()
    );
    const completed = await renderPage(
      automationDetailFixture({ activation: ready })
    );
    expect(completed.queryByText(resultsTitle)).not.toBeNull();
    cleanup();

    loadAutomationDryRun.mockImplementation(async () =>
      automationDryRunFixture({ status: "failed" })
    );
    const failed = await renderPage(automationDetailFixture());
    expect(failed.queryByText(resultsTitle)).toBeNull();
  });

  test("starts the progress bar empty before the job counts its units", async () => {
    const view = await renderPage(
      automationDetailFixture({
        activation: { ...running, unitsDone: 0, unitsTotal: 0 },
      })
    );
    const bar = view.getByRole("progressbar").firstElementChild;
    assert(bar instanceof HTMLElement, "Expected a progress indicator");

    expect(bar.style.width).toBe("0%");
    expect(view.getByRole("status").textContent).toBe(
      m.emailAutomationActivationProgress({ done: 0, total: 0 }, { locale })
    );
  });

  test("says how far a running job got", async () => {
    const view = await renderPage(
      automationDetailFixture({ activation: running })
    );
    const bar = view.getByRole("progressbar").firstElementChild;
    assert(bar instanceof HTMLElement, "Expected a progress indicator");

    expect(bar.style.width).toBe("30%");
  });
});
