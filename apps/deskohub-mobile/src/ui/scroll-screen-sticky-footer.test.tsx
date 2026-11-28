import { describe, expect, test } from "bun:test";
import { act } from "react";
import { clientRoot } from "../testing/client-root";
import {
  type ContentBox,
  type PinnedFooter,
  ScrollScreen,
  StickyFooterGroup,
  type StickyFooterHost,
  StickyFooterHostContext,
  stickyFooterPinned,
  useIsHiddenStickyCopy,
} from "./scroll-screen";
import { find, hostTree } from "./testing/element-tree";
import { Text } from "./text";

type Measured = (x: number, y: number, width: number, height: number) => void;

const box = (y: number, height: number): ContentBox => ({
  x: 16,
  y,
  width: 328,
  height,
});

describe("stickyFooterPinned", () => {
  const group = box(100, 600);
  const footer = box(650, 50);

  test("pins while the footer's place lies below the line", () => {
    expect(stickyFooterPinned({ pinLine: 500, group, footer })).toBe(true);
  });

  test("rests in place once the line reaches the group's end", () => {
    expect(stickyFooterPinned({ pinLine: 700, group, footer })).toBe(false);
    expect(stickyFooterPinned({ pinLine: 900, group, footer })).toBe(false);
  });

  test("stays inside its group: no pin before the group shows", () => {
    expect(stickyFooterPinned({ pinLine: 149, group, footer })).toBe(false);
    expect(stickyFooterPinned({ pinLine: 150, group, footer })).toBe(true);
  });
});

/** A screen stand-in whose scroll the test moves. */
const fakeHost = (group: ContentBox, footer: ContentBox) => {
  const listeners = new Set<(change: "scroll" | "layout") => void>();
  const pins: Array<PinnedFooter | undefined> = [];
  let line = 0;
  let measured = 0;
  const host: StickyFooterHost = {
    // The group measures first, then its footer.
    measure: (_node, onBox) => onBox(measured++ % 2 === 0 ? group : footer),
    pinLine: () => line,
    belowPinned: () => 90,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pin: (_key, pinned) => {
      pins.push(pinned);
    },
  };
  const notify = (change: "scroll" | "layout") =>
    act(() => {
      for (const listener of listeners) listener(change);
    });
  return {
    host,
    pins,
    listeners,
    layout: () => notify("layout"),
    scrollTo: (pinLine: number) => {
      line = pinLine;
      return notify("scroll");
    },
  };
};

describe("StickyFooterGroup", () => {
  const root = clientRoot();

  test("pins its footer while the group scrolls and rests it at the end", async () => {
    const screen = fakeHost(box(100, 600), box(650, 50));
    const obstructions: Array<number> = [];
    await root.render(
      <StickyFooterHostContext value={screen.host}>
        <StickyFooterGroup
          footer={<Text>footer</Text>}
          onObstruction={(height) => obstructions.push(height)}
        >
          <Text>rows</Text>
        </StickyFooterGroup>
      </StickyFooterHostContext>
    );
    await screen.scrollTo(500);
    await screen.layout();
    expect(screen.pins.at(-1)).toMatchObject({ x: 16, width: 328 });
    // The pinned copy covers its height above the screen's bottom chrome.
    expect(obstructions.at(-1)).toBe(90 + 50);

    await screen.scrollTo(720);
    expect(screen.pins.at(-1)).toBeUndefined();
    expect(obstructions.at(-1)).toBe(0);

    await screen.scrollTo(400);
    expect(screen.pins.at(-1)).toBeDefined();
  });

  test("its layout handlers are set from mount, before any footer", () => {
    // React Native Web observes a view's layout only when it has a handler
    // as it mounts, and the footer comes once eligibility settles.
    const group = find(
      hostTree(
        <StickyFooterGroup>
          <Text>rows</Text>
        </StickyFooterGroup>
      ),
      "View"
    );
    expect(typeof group?.props.onLayout).toBe("function");
    const scrollView = find(
      hostTree(
        <ScrollScreen>
          <Text>rows</Text>
        </ScrollScreen>
      ),
      "ScrollView"
    );
    expect(typeof scrollView?.props.onContentSizeChange).toBe("function");
  });

  test("a group without a footer never follows the scroll", async () => {
    const screen = fakeHost(box(100, 600), box(650, 50));
    await root.render(
      <StickyFooterHostContext value={screen.host}>
        <StickyFooterGroup>
          <Text>rows</Text>
        </StickyFooterGroup>
      </StickyFooterHostContext>
    );
    expect(screen.listeners.size).toBe(0);
  });

  test("on a screen, it pins at once from where the content already is", async () => {
    // The content scrolled 400 down a 700 high viewport before the footer
    // showed: no scroll event will tell it so.
    const inner = {
      measureInWindow: (done: Measured) => done(0, -400, 360, 0),
    };
    const relativeTo: Array<unknown> = [];
    const stubs = {
      getNativeScrollRef() {
        return { measureInWindow: (done: Measured) => done(0, 0, 360, 700) };
      },
      getInnerViewRef: () => inner,
      measureLayout(
        this: HTMLElement,
        to: unknown,
        done: (x: number, y: number, width: number, height: number) => void
      ) {
        relativeTo.push(to);
        if (this.textContent === "footer") done(16, 1250, 328, 50);
        else done(16, 100, 328, 1200);
      },
    };
    Object.assign(HTMLElement.prototype, stubs);
    function Probe() {
      return <Text>{useIsHiddenStickyCopy() ? "hidden" : "footer"}</Text>;
    }
    try {
      await root.render(
        <ScrollScreen>
          <StickyFooterGroup footer={<Probe />}>
            <Text>rows</Text>
          </StickyFooterGroup>
        </ScrollScreen>
      );
      // Measured in the scrolled content's own frame, the one its offset is in.
      expect(relativeTo.length).toBeGreaterThan(0);
      expect(relativeTo.every((to) => to === inner)).toBe(true);
      const texts = Array.from(root.container().querySelectorAll("Text"));
      const exposed = texts.filter(
        (text) => text.closest('[aria-hidden="true"]') === null
      );
      // The footer in place hides; the pinned copy in sight is the one to
      // read and focus.
      expect(texts.map((text) => text.textContent).sort()).toEqual([
        "footer",
        "hidden",
        "rows",
      ]);
      expect(exposed.map((text) => text.textContent).sort()).toEqual([
        "footer",
        "rows",
      ]);
      const pinned = exposed.find((text) => text.textContent === "footer");
      expect(pinned?.closest("ScrollView")).toBeNull();
    } finally {
      for (const key of Object.keys(stubs))
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
          key
        ];
    }
  });
});
