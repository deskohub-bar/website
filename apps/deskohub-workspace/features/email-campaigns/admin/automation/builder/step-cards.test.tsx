import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import assert from "node:assert/strict";
import {
  AdministrationCampaignDetail,
  automationOneOffCampaignGapMaxDays,
} from "@deskohub/workspace-admin-api";
import { Schema } from "effect";
import { m } from "@/features/administration/i18n";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import {
  registerWorkspaceComponentTestEnv,
  unregisterWorkspaceComponentTestEnv,
} from "@/shared/testing/workspace-component-test-env";
import type { FlowStepValue } from "./automation-flow-form";
import {
  campaignOperationInputs,
  isValidFlow,
  resetCampaignOperations,
  stubCampaignOperations,
} from "./flow-builder.test-utils";

mock.module("../../campaign-operations.actions", () => ({
  runCampaignOperation: mock(),
}));

registerWorkspaceComponentTestEnv();
// React DOM and Radix detect the DOM when they load, so they load after it.
const { act, cleanup, fireEvent, render, within } = await import(
  "@testing-library/react"
);
const { SendStepCard, WaitStepCard } = await import("./step-cards");

beforeEach(stubCampaignOperations);
afterEach(cleanup);
afterAll(async () => {
  resetCampaignOperations();
  await unregisterWorkspaceComponentTestEnv();
});

type WaitStep = Extract<FlowStepValue, { _tag: "Wait" }>;

const locale = "en-US";
const durationWait: WaitStep = {
  _tag: "Wait",
  id: "wait-1",
  wait: { _tag: "Duration", count: 2, unit: "hour" },
};
const calendarWait: WaitStep = {
  _tag: "Wait",
  id: "wait-1",
  wait: { _tag: "Calendar", expression: { hours: [10] } },
};

/** The one step a card emitted, checked as a wait the admin API takes. */
const emittedStep = (calls: readonly (readonly [WaitStep])[]) => {
  expect(calls).toHaveLength(1);
  const [next] = calls[0] ?? [];
  if (!next) throw new Error("Expected a step");
  expect(
    isValidFlow({
      trigger: { _tag: "AccountCreated" },
      steps: [next, { _tag: "Send", id: "send" }],
    })
  ).toBe(true);
  return next;
};

const renderWait = (
  step: WaitStep,
  errorAt: (field: string) => string | undefined = () => undefined
) => {
  const onChange = mock((_step: WaitStep) => undefined);
  const view = render(
    <RouteLocaleProvider locale={locale}>
      <WaitStepCard
        step={step}
        number={1}
        onChange={onChange}
        menu={null}
        errorAt={errorAt}
        initialPreview={undefined}
      />
    </RouteLocaleProvider>
  );
  const mode = (value: WaitStep["wait"]["_tag"]) => {
    const radio = view
      .getAllByRole("radio")
      .find((candidate) => candidate.getAttribute("value") === value);
    assert(radio, `Expected the ${value} radio button`);
    return radio;
  };
  const count = () =>
    view.queryByRole("spinbutton", {
      name: m.emailAutomationFlowWaitCountLabel({}, { locale }),
    });
  const unit = () =>
    view.queryByRole("combobox", {
      name: m.emailAutomationFlowWaitUnitLabel({}, { locale }),
    });
  const hours = () =>
    view.queryByRole("group", {
      name: m.emailAutomationFlowCalendarPart({ part: "hours" }, { locale }),
    });
  return { view, onChange, mode, count, unit, hours };
};

test("a duration wait shows its count and unit, not a calendar", () => {
  const { count, unit, hours } = renderWait(durationWait);

  expect(count()).not.toBeNull();
  expect(unit()).not.toBeNull();
  expect(hours()).toBeNull();
});

test("editing the count keeps the duration's unit", () => {
  const { onChange, count } = renderWait(durationWait);

  const countInput = count();
  assert(countInput, "Expected the wait count input");
  act(() => {
    fireEvent.change(countInput, { target: { value: "3" } });
  });

  expect(onChange.mock.calls).toEqual([
    [{ ...durationWait, wait: { _tag: "Duration", count: 3, unit: "hour" } }],
  ]);
});

test("switching to a calendar emits a calendar wait and previews it", () => {
  const { onChange, mode } = renderWait(durationWait);

  act(() => {
    fireEvent.click(mode("Calendar"));
  });

  const next = emittedStep(onChange.mock.calls);
  expect(next.id).toBe(durationWait.id);
  if (next.wait._tag !== "Calendar") throw new Error("Expected a calendar");
  expect(campaignOperationInputs("previewCalendarExpression")).toEqual([
    { expression: next.wait.expression, usage: "wait", locale },
  ]);
});

test("a calendar wait shows the calendar editor, not a count", () => {
  const { count, unit, hours } = renderWait(calendarWait);

  expect(hours()).not.toBeNull();
  expect(count()).toBeNull();
  expect(unit()).toBeNull();
});

test("editing the calendar emits the new expression and previews it", () => {
  const { onChange, hours } = renderWait(calendarWait);

  act(() => {
    const hoursGroup = hours();
    assert(hoursGroup, "Expected the calendar hours group");
    fireEvent.click(within(hoursGroup).getByRole("button", { name: "11:00" }));
  });

  const expression = { hours: [10, 11] };
  expect(onChange.mock.calls).toEqual([
    [{ ...calendarWait, wait: { _tag: "Calendar", expression } }],
  ]);
  expect(campaignOperationInputs("previewCalendarExpression")).toEqual([
    { expression, usage: "wait", locale },
  ]);
});

test("switching back to a duration emits a duration wait", () => {
  const { onChange, mode } = renderWait(calendarWait);

  act(() => {
    fireEvent.click(mode("Duration"));
  });

  const next = emittedStep(onChange.mock.calls);
  expect(next.id).toBe(calendarWait.id);
  expect(next.wait._tag).toBe("Duration");
  expect(campaignOperationInputs("previewCalendarExpression")).toEqual([]);
});

test("an invalid count is described by its mounted error", () => {
  const valid = renderWait(durationWait);
  const alert = valid.view.getByRole("alert");
  expect(alert.textContent).toBe("");
  expect(valid.count()?.getAttribute("aria-invalid")).toBe("false");
  expect(valid.count()?.hasAttribute("aria-describedby")).toBe(false);
  cleanup();

  const invalid = renderWait(
    { ...durationWait, wait: { _tag: "Duration", count: 0, unit: "hour" } },
    (field) => (field === "count" ? "Expected a positive count" : undefined)
  );
  const count = invalid.count();
  assert(count, "Expected the wait count input");
  expect(count.getAttribute("aria-invalid")).toBe("true");
  const error = invalid.view.getByRole("alert");
  expect(count.getAttribute("aria-describedby")).toBe(error.id);
  expect(error.textContent).not.toBe("");
});

type SendStep = Extract<FlowStepValue, { _tag: "Send" }>;

const campaign = Schema.decodeUnknownSync(AdministrationCampaignDetail)({
  id: "01990000-0000-7000-8000-000000000001",
  title: "Synthetic automated campaign",
  purpose: "marketing",
  templateKey: "workspace",
  delivery: "automated",
  status: "draft",
  audienceId: null,
  locales: ["en-US"],
  createdAt: "2026-10-19T08:00:00Z",
  updatedAt: "2026-10-19T08:00:00Z",
  content: {},
});
const plainSend: SendStep = { _tag: "Send", id: "send" };
const ruledSend: SendStep = {
  ...plainSend,
  oncePerCustomer: true,
  oneOffCampaignGap: { days: 21 },
  skipPassHolders: true,
};

const renderSend = (
  step: SendStep,
  {
    editable = true,
    skipPassHoldersAvailable,
    errorAt = () => undefined,
  }: {
    readonly editable?: boolean;
    readonly skipPassHoldersAvailable?: boolean;
    readonly errorAt?: (field: string) => string | undefined;
  } = {}
) => {
  const onChange = mock((_step: SendStep) => undefined);
  const view = render(
    <RouteLocaleProvider locale={locale}>
      <SendStepCard
        campaign={campaign}
        step={step}
        number={2}
        skipPassHoldersAvailable={skipPassHoldersAvailable}
        onChange={editable ? onChange : undefined}
        errorAt={errorAt}
      />
    </RouteLocaleProvider>
  );
  const checkbox = (label: string) =>
    view.queryByRole("checkbox", { name: label });
  const controls = {
    once: () =>
      checkbox(m.emailAutomationFlowSendOncePerCustomerLabel({}, { locale })),
    gap: () => checkbox(m.emailAutomationFlowSendGapLabel({}, { locale })),
    skip: () =>
      checkbox(m.emailAutomationFlowSendSkipPassHoldersLabel({}, { locale })),
    gapDays: () =>
      view.queryByRole("spinbutton", {
        name: m.emailAutomationFlowSendGapDaysLabel({}, { locale }),
      }),
  };
  const summary = () =>
    view.getByRole("region", {
      name: m.emailAutomationFlowSendPoliciesTitle({}, { locale }),
    });
  const click = (element: HTMLElement | null) => {
    assert(element, "Expected a sending policy control");
    return act(() => {
      fireEvent.click(element);
    });
  };
  return { view, onChange, controls, summary, click };
};

/** The one Send step a card emitted, checked as a step the admin API takes. */
const emittedSend = (calls: readonly (readonly [SendStep])[]) => {
  expect(calls).toHaveLength(1);
  const [next] = calls[0] ?? [];
  if (!next) throw new Error("Expected a step");
  expect(
    isValidFlow({ trigger: { _tag: "AccountCreated" }, steps: [next] })
  ).toBe(true);
  return next;
};

describe("SendStepCard delivery rules", () => {
  test("an editable card shows each rule's control as the step holds it", () => {
    const { controls } = renderSend({ ...plainSend, skipPassHolders: true });

    expect(controls.once()?.getAttribute("aria-checked")).toBe("false");
    expect(controls.gap()?.getAttribute("aria-checked")).toBe("false");
    expect(controls.skip()?.getAttribute("aria-checked")).toBe("true");
    expect(controls.gapDays()).toBeNull();
  });

  test("under a pass reminder trigger, skipping pass holders is offered only to turn it off", () => {
    const off = renderSend(plainSend, { skipPassHoldersAvailable: false });
    expect(off.controls.skip()).toBeNull();
    expect(off.controls.once()).not.toBeNull();
    off.view.unmount();

    const on = renderSend(
      { ...plainSend, skipPassHolders: true },
      { skipPassHoldersAvailable: false }
    );
    on.click(on.controls.skip());
    expect(emittedSend(on.onChange.mock.calls)).toEqual(plainSend);
  });

  test.each([
    ["once", { oncePerCustomer: true }],
    ["gap", { oneOffCampaignGap: { days: 14 } }],
    ["skip", { skipPassHolders: true }],
  ] as const)("turning on %s adds only its key", (control, added) => {
    const { onChange, controls, click } = renderSend(plainSend);

    click(controls[control]());

    expect(emittedSend(onChange.mock.calls)).toStrictEqual({
      ...plainSend,
      ...added,
    });
  });

  test.each([
    ["once", "oncePerCustomer"],
    ["gap", "oneOffCampaignGap"],
    ["skip", "skipPassHolders"],
  ] as const)("turning off %s removes its key", (control, key) => {
    const { onChange, controls, click } = renderSend(ruledSend);

    click(controls[control]());

    const next = emittedSend(onChange.mock.calls);
    expect(Object.hasOwn(next, key)).toBe(false);
    const { [key]: _removed, ...kept } = ruledSend;
    expect(next).toStrictEqual(kept);
  });

  test("editing the gap's days keeps the other rules", () => {
    const { onChange, controls } = renderSend(ruledSend);

    const days = controls.gapDays();
    assert(days, "Expected the campaign gap input");
    act(() => {
      fireEvent.change(days, {
        target: { value: "30" },
      });
    });

    expect(emittedSend(onChange.mock.calls)).toStrictEqual({
      ...ruledSend,
      oneOffCampaignGap: { days: 30 },
    });
  });

  test.each([0, automationOneOffCampaignGapMaxDays + 1])(
    "a gap of %i days is outside what the admin API takes",
    (days) => {
      expect(
        isValidFlow({
          trigger: { _tag: "AccountCreated" },
          steps: [{ ...plainSend, oneOffCampaignGap: { days } }],
        })
      ).toBe(false);
    }
  );

  test("an invalid gap is described by its mounted error", () => {
    const { controls, view } = renderSend(
      { ...plainSend, oneOffCampaignGap: { days: 0 } },
      {
        errorAt: (field) =>
          field === "oneOffCampaignGap.days" ? "Expected 1 to 90" : undefined,
      }
    );
    const days = controls.gapDays();
    assert(days, "Expected the campaign gap input");
    const error = view.getByRole("alert");

    expect(days.getAttribute("aria-invalid")).toBe("true");
    expect(days.getAttribute("aria-describedby")).toBe(error.id);
    expect(error.textContent).not.toBe("");
  });

  test("the summary lists one sentence per active rule, or says there are none", () => {
    const ruled = renderSend(ruledSend);
    expect(
      within(ruled.summary())
        .getAllByRole("listitem")
        .map((item) => item.textContent)
    ).toEqual([
      m.emailAutomationFlowSendOncePerCustomerSummary({}, { locale }),
      m.emailAutomationFlowSendGapSummary({ count: 21 }, { locale }),
      m.emailAutomationFlowSendSkipPassHoldersSummary({}, { locale }),
    ]);
    cleanup();

    const plain = renderSend(plainSend);
    expect(within(plain.summary()).queryByRole("list")).toBeNull();
    expect(plain.summary().textContent).toContain(
      m.emailAutomationFlowSendPoliciesNone({}, { locale })
    );
  });

  test("a read-only card shows the summary without controls", () => {
    const { controls, summary } = renderSend(ruledSend, { editable: false });

    expect(within(summary()).getAllByRole("listitem")).toHaveLength(3);
    expect([
      controls.once(),
      controls.gap(),
      controls.skip(),
      controls.gapDays(),
    ]).toEqual([null, null, null, null]);
  });
});
