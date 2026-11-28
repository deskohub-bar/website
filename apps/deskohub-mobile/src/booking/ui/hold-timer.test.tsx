import { describe, expect, mock, test } from "bun:test";
import { act, type ReactElement, type ReactNode } from "react";
import { AppLocaleProvider } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { clientRoot } from "../../testing/client-root";
import { Icon } from "../../ui/icon";
import {
  elementTree,
  find,
  findAll,
  flatStyle,
  hostTree,
  textOf,
} from "../../ui/testing/element-tree";
import { Text } from "../../ui/text";
import { color } from "../../ui/tokens";
import {
  HoldChip,
  HoldEndedDialog,
  type HoldStatus,
  HoldStatusChip,
  holdCountdown,
  useHoldCountdown,
} from "./hold-timer";

const expiresAt = "2026-11-15T12:10:00.000Z";
const expiry = Date.parse(expiresAt);
const before = (millis: number) => expiry - millis;

describe("holdCountdown", () => {
  test.each([
    ["more than a minute", 61_000, { secondsLeft: 61, phase: "held" }],
    ["exactly a minute", 60_000, { secondsLeft: 60, phase: "ending" }],
    ["under a minute", 59_000, { secondsLeft: 59, phase: "ending" }],
    ["at expiry", 0, { secondsLeft: 0, phase: "ended" }],
    ["past expiry", -5_000, { secondsLeft: 0, phase: "ended" }],
  ] as const)("with %s left", (_, millisLeft, expected) => {
    expect(holdCountdown(expiresAt, before(millisLeft))).toEqual(expected);
  });

  test("rounds a part second up, so the last moment still shows 0:01", () => {
    expect(holdCountdown(expiresAt, before(1))).toEqual({
      secondsLeft: 1,
      phase: "ending",
    });
    expect(holdCountdown(expiresAt, before(60_001))).toEqual({
      secondsLeft: 61,
      phase: "held",
    });
  });

  test("an expiry that doesn't parse has ended", () => {
    expect(holdCountdown("not a time", before(60_000))).toEqual({
      secondsLeft: 0,
      phase: "ended",
    });
  });
});

const chip = (status: HoldStatus) =>
  elementTree(HoldStatusChip, { status, locale: "en-US" }) as ReactElement<{
    role?: string;
    "aria-label"?: string;
    style?: unknown;
    children?: ReactNode;
  }>;

const chipIcon = (status: HoldStatus) =>
  find<Parameters<typeof Icon>[0]>(chip(status), Icon)?.props;

describe("HoldStatusChip", () => {
  test.each([
    [597, "held", "9:57"],
    [60, "ending", "1:00"],
    [58, "ending", "0:58"],
    [5, "ending", "0:05"],
    [0, "ended", "0:00"],
    [600, "held", "10:00"],
  ] as const)(
    "shows and announces %i seconds as a %s timer at %s",
    (secondsLeft, phase, time) => {
      const tree = chip({ secondsLeft, phase });
      const { props } = tree;
      expect(props.role).toBe("timer");
      expect(props["aria-label"]).toBe(
        m.booking_hold_chip_label({ time }, { locale: "en-US" })
      );
      expect(
        find<{ children?: ReactNode; numeric?: boolean }>(tree, Text)?.props
      ).toMatchObject({ children: time, numeric: true });
    }
  );

  test("a held chip is sunken navy with a timer icon", () => {
    const status = { secondsLeft: 597, phase: "held" } as const;
    expect(flatStyle(chip(status).props.style)).toMatchObject({
      backgroundColor: color.sunken,
    });
    expect(flatStyle(chip(status).props.style).boxShadow).toBeUndefined();
    expect(chipIcon(status)?.color).toBe(color.navy);
  });

  test("an ending chip turns amber with an amber ring", () => {
    const status = { secondsLeft: 58, phase: "ending" } as const;
    const style = flatStyle(chip(status).props.style);
    expect(style.backgroundColor).toBe(color.warningTint);
    expect(String(style.boxShadow)).toContain(color.warning);
    expect(chipIcon(status)?.color).toBe(color.warningInk);
  });

  test("an ended chip turns red with an alert icon instead of the timer", () => {
    const ended = { secondsLeft: 0, phase: "ended" } as const;
    const held = { secondsLeft: 597, phase: "held" } as const;
    expect(flatStyle(chip(ended).props.style).backgroundColor).toBe(
      color.dangerTint
    );
    expect(chipIcon(ended)?.color).toBe(color.dangerInk);
    expect(chipIcon(ended)?.icon).not.toBe(chipIcon(held)?.icon);
  });
});

const dialogFor = (handlers: {
  onCheckDate: () => void;
  onLeave: () => void;
}) =>
  hostTree(
    elementTree(HoldEndedDialog, {
      visible: true,
      locale: "en-US",
      ...handlers,
    })
  );

describe("HoldEndedDialog", () => {
  test("is an alert dialog that dismisses to checking the date again", () => {
    const onCheckDate = mock(() => undefined);
    const onLeave = mock(() => undefined);
    const dialog = dialogFor({ onCheckDate, onLeave });
    const modal = find(dialog, "Modal");
    expect(modal?.props.visible).toBe(true);
    expect(
      findAll(modal, "View").some((view) => view.props.role === "alertdialog")
    ).toBe(true);
    const dismiss = modal?.props.onRequestClose;
    if (typeof dismiss !== "function")
      throw new Error("The alert cannot be dismissed");
    dismiss();
    expect(onCheckDate).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
  });

  test("leads with the primary check-the-date action, then a quiet leave", () => {
    const onCheckDate = mock(() => undefined);
    const onLeave = mock(() => undefined);
    const buttons = findAll(
      dialogFor({ onCheckDate, onLeave }),
      "Pressable"
    ).filter((button) => button.props.role === "button");
    const locale = "en-US";
    expect(
      buttons.map((button) => findAll(button, "Text").map(textOf).join(""))
    ).toEqual([
      m.booking_hold_ended_check_date({}, { locale }),
      m.booking_hold_ended_leave({}, { locale }),
    ]);
    const [checkDate, leave] = buttons;
    const pressCheckDate = checkDate?.props.onPress;
    const pressLeave = leave?.props.onPress;
    if (
      typeof pressCheckDate !== "function" ||
      typeof pressLeave !== "function"
    ) {
      throw new Error("The alert is missing an action");
    }
    const backgrounds = buttons.map(
      ({ props: { style } }) =>
        flatStyle(
          typeof style === "function" ? style({ pressed: false }) : style
        ).backgroundColor
    );
    expect(backgrounds).toEqual([color.action, "transparent"]);
    pressCheckDate();
    expect(onCheckDate).toHaveBeenCalledTimes(1);
    expect(onLeave).not.toHaveBeenCalled();
    pressLeave();
    expect(onCheckDate).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe("useHoldCountdown", () => {
  const { render } = clientRoot();
  // Real time passes inside act, so the clock's re-renders land in it.
  const pass = (millis: number) =>
    act(() => new Promise((resolve) => setTimeout(resolve, millis)));

  test("is right on the first render and counts down each second", async () => {
    const seen: Array<HoldStatus> = [];
    const expiresAt = new Date(Date.now() + 65_000).toISOString();
    function Probe() {
      seen.push(useHoldCountdown(expiresAt));
      return null;
    }
    await render(
      <AppLocaleProvider locale="en-US">
        <Probe />
      </AppLocaleProvider>
    );
    expect(seen[0]?.phase).toBe("held");
    expect(seen[0]?.secondsLeft).toBeOneOf([65, 64]);

    // At least two ticks, however slowly a loaded machine runs timers.
    const deadline = Date.now() + 10_000;
    while ((seen.at(-1)?.secondsLeft ?? 65) > 63 && Date.now() < deadline) {
      await pass(100);
    }
    const last = seen.at(-1);
    expect(last?.secondsLeft).toBeLessThanOrEqual(63);
    // Never behind the time: the last render shows at least what's left now.
    expect(last?.secondsLeft).toBeGreaterThanOrEqual(
      holdCountdown(expiresAt, Date.now()).secondsLeft
    );
    await render(null);
  });

  test("a countdown mounted while the clock already runs starts from now", async () => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    function Running() {
      useHoldCountdown(expiresAt);
      return null;
    }
    let first: HoldStatus | undefined;
    let fresh = "";
    function Mounted() {
      const status = useHoldCountdown(fresh);
      first ??= status;
      return null;
    }
    await render(<Running />);
    // Between the running clock's ticks, a new hold of exactly 30 seconds.
    await pass(1_500);
    fresh = new Date(Date.now() + 30_000).toISOString();
    await render(
      <>
        <Running />
        <Mounted />
      </>
    );
    expect(first?.secondsLeft).toBeLessThanOrEqual(30);
    expect(first?.secondsLeft).toBeGreaterThanOrEqual(29);
    await render(null);
  });

  test("a hold that has just expired mounts as ended", async () => {
    const expiresAt = new Date(Date.now() - 1).toISOString();
    let first: HoldStatus | undefined;
    function Mounted() {
      const status = useHoldCountdown(expiresAt);
      first ??= status;
      return null;
    }
    await render(<Mounted />);
    expect(first).toEqual({ secondsLeft: 0, phase: "ended" });
    await render(null);
  });

  test("HoldChip shows and warns about the remaining time in the last minute", async () => {
    let drawn: ReactNode = null;
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    function Probe() {
      drawn = HoldChip({ expiresAt, locale: "en-US" });
      return null;
    }
    await render(<Probe />);
    const timer = find(hostTree(drawn), "View");
    const time = find(timer, "Text");
    if (time === undefined)
      throw new Error("The hold timer has no visible time");
    expect(timer?.props.role).toBe("timer");
    expect(textOf(time)).toBeOneOf(["0:30", "0:29"]);
    expect(timer?.props["aria-label"]).toBe(
      m.booking_hold_chip_label({ time: textOf(time) }, { locale: "en-US" })
    );
    const look = flatStyle(timer?.props.style);
    expect(look.backgroundColor).toBe(color.warningTint);
    expect(String(look.boxShadow)).toContain(color.warning);
    await render(null);
  });
});
