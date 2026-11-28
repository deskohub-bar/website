import {
  type ComponentRef,
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type LayoutChangeEvent,
  RefreshControl,
  ScrollView,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
import {
  FocusedFieldContext,
  useFocusedFieldScroll,
} from "./focused-field-scroll";
import { LoadingIndicator } from "./loading-indicator";
import { color, radius, shadow, space, tabBarRaisedOverhang } from "./tokens";
import { type ContentWidth, useContentColumn, useViewport } from "./viewport";

/**
 * Scrolls the enclosing `ScrollScreen` back to its top; outside one, it does
 * nothing.
 */
export const ScrollScreenContext = createContext<() => void>(() => undefined);

/**
 * Brings the top of the enclosing `ScrollScreen` into view at once, for
 * content that just appeared there, such as a notice about why the screen
 * changed.
 */
export const useScrollScreenToTop = () => useContext(ScrollScreenContext);

// The pull gesture stays native; its spinner is drawn see-through so the
// shared loading indicator stands in for it.
const hiddenSpinner = "transparent";

/** How far the first content overlaps the masthead's navy band. */
const mastheadOverlap = 40;

/**
 * Starts a tab root's content below the masthead's navy overlap, for content
 * that doesn't open with a card (such as a section header), whose text would
 * otherwise sit on the navy band.
 */
export function MastheadClearance() {
  return <View aria-hidden style={styles.clearance} />;
}

/** A view's frame within the scrolled content. */
export interface ContentBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A sticky footer's copy, drawn over the bottom of the screen. */
export interface PinnedFooter {
  readonly node: ReactNode;
  /** Its group's left edge and width within the content. */
  readonly x: number;
  readonly width: number;
  readonly style?: StyleProp<ViewStyle>;
}

/** What a `StickyFooterGroup` reads from, and draws through, its screen. */
export interface StickyFooterHost {
  /** Reports `node`'s frame within the scrolled content, once laid out. */
  readonly measure: (
    node: ComponentRef<typeof View> | null,
    onBox: (box: ContentBox) => void
  ) => void;
  /** The content line a pinned footer ends on: the visible bottom, less its gap. */
  readonly pinLine: () => number;
  /** How far below the screen's pinned footers the window ends. */
  readonly belowPinned: () => number;
  /** Calls back on each scroll, and with "layout" when frames may have moved. */
  readonly subscribe: (
    listener: (change: "scroll" | "layout") => void
  ) => () => void;
  /** Draws `footer` over the screen's bottom under `key`; undefined removes it. */
  readonly pin: (key: string, footer: PinnedFooter | undefined) => void;
}

export const StickyFooterHostContext = createContext<
  StickyFooterHost | undefined
>(undefined);

/** Whether this copy of a sticky footer is the one out of sight. */
const HiddenCopyContext = createContext(false);

/**
 * Whether this copy of a sticky footer is the hidden one, which assistive
 * technology and keyboard focus skip: while the footer is pinned they reach
 * its pinned copy, and otherwise the footer in its place.
 */
export const useIsHiddenStickyCopy = () => useContext(HiddenCopyContext);

/**
 * Whether a group's footer pins to the bottom of the screen, as CSS
 * `position: sticky; bottom: 0` would inside the group: while its place lies
 * below `pinLine` and the group starts at least a footer's height above it.
 */
export const stickyFooterPinned = ({
  pinLine,
  group,
  footer,
}: {
  readonly pinLine: number;
  readonly group: ContentBox;
  readonly footer: ContentBox;
}): boolean =>
  footer.y + footer.height > pinLine + 0.5 &&
  group.y + footer.height <= pinLine;

/**
 * A group whose `footer` ends it, and sticks above the bottom of its
 * `ScrollScreen` (clear of the tab bar's raised circle) while the group
 * runs on below it; at the group's end the footer rests in place. The
 * pinned copy takes `pinnedStyle`. Assistive technology and keyboard focus
 * reach only the copy in sight (see `useIsHiddenStickyCopy`). `onObstruction`
 * hears how much of the window's bottom the pinned copy covers, 0 while
 * none shows, for the toast. Outside a `ScrollScreen` the footer never pins.
 */
export function StickyFooterGroup({
  style,
  footer,
  pinnedStyle,
  onObstruction,
  children,
}: {
  readonly style?: StyleProp<ViewStyle>;
  readonly footer?: ReactNode;
  readonly pinnedStyle?: StyleProp<ViewStyle>;
  readonly onObstruction?: (height: number) => void;
  readonly children: ReactNode;
}) {
  const host = useContext(StickyFooterHostContext);
  const key = useId();
  const groupView = useRef<ComponentRef<typeof View>>(null);
  const footerView = useRef<ComponentRef<typeof View>>(null);
  const boxes = useRef<{ group?: ContentBox; footer?: ContentBox }>({});
  const [pinned, setPinned] = useState(false);
  // How much of the window's bottom the pinned copy covers.
  const [covered, setCovered] = useState(0);
  const [frame, setFrame] = useState<ContentBox>();
  const shown = footer !== undefined && footer !== null && footer !== false;
  const update = useCallback(() => {
    const { group, footer: place } = boxes.current;
    const pinnedNow =
      host !== undefined &&
      group !== undefined &&
      place !== undefined &&
      // Not before the footer is laid out.
      place.height > 0 &&
      stickyFooterPinned({ pinLine: host.pinLine(), group, footer: place });
    setPinned(pinnedNow);
    setCovered(pinnedNow ? host.belowPinned() + place.height : 0);
  }, [host]);
  const remeasure = useCallback(() => {
    if (host === undefined || !shown) return;
    host.measure(groupView.current, (box) => {
      boxes.current.group = box;
      setFrame((last) =>
        last?.x === box.x &&
        last.width === box.width &&
        last.height === box.height
          ? last
          : box
      );
      update();
    });
    host.measure(footerView.current, (box) => {
      boxes.current.footer = box;
      update();
    });
  }, [host, shown, update]);
  // Only a group with a footer follows the scroll.
  useEffect(() => {
    if (!shown) return;
    return host?.subscribe((change) =>
      change === "layout" ? remeasure() : update()
    );
  }, [host, shown, remeasure, update]);
  const pinning = shown && pinned && frame !== undefined;
  useEffect(() => {
    if (host === undefined || !pinning) return;
    host.pin(key, {
      node: footer,
      x: frame.x,
      width: frame.width,
      style: pinnedStyle,
    });
    return () => host.pin(key, undefined);
  }, [host, key, pinning, footer, frame, pinnedStyle]);
  const obstruction = pinning ? covered : 0;
  useEffect(() => {
    onObstruction?.(obstruction);
  }, [onObstruction, obstruction]);
  return (
    <View
      ref={groupView}
      style={style}
      // Always set: React Native Web observes a view's layout only when it
      // has a handler as it mounts, and the footer can come later.
      onLayout={remeasure}
    >
      {children}
      {shown && (
        // While pinned, the copy drawn over the screen is the footer to see,
        // read and focus; this place stays only for the layout.
        <View
          ref={footerView}
          onLayout={remeasure}
          aria-hidden={pinning}
          style={pinning ? styles.coveredFooter : undefined}
        >
          <HiddenCopyContext value={pinning}>{footer}</HiddenCopyContext>
        </View>
      )}
    </View>
  );
}

/**
 * The pinned footers over the bottom of a `ScrollScreen`, on a paper band
 * that hides the content scrolling between them and the screen's bottom.
 */
function PinnedFooters({
  footers,
  bottom,
  left,
}: {
  readonly footers: ReadonlyMap<string, PinnedFooter>;
  readonly bottom: number;
  readonly left: number;
}) {
  return (
    <>
      {/* The content stops above the pinned footers, as above a bar: the
          band takes the taps on what scrolls under it. */}
      <View aria-hidden style={[styles.belowPinned, { height: bottom }]} />
      {Array.from(footers, ([key, pinned]) => (
        <View
          key={key}
          style={[
            styles.pinned,
            { bottom, left: left + pinned.x, width: pinned.width },
            pinned.style,
          ]}
        >
          {pinned.node}
        </View>
      ))}
    </>
  );
}

/**
 * A scrolling screen under a navigation header (or its own `masthead`) and
 * above the tab bar, which own the top and bottom insets. Content sits on
 * the screen gutter. A `masthead` scrolls with the content, and the first
 * content overlaps its navy band. Passing `onRefresh` turns on
 * pull-to-refresh; `refreshing` shows the loading indicator at the top
 * while it runs. Its content can scroll it back to the top with
 * `useScrollScreenToTop`. A `collapsedHeader`, such as an `AppBar` with the
 * masthead's title and actions (and a dark `FocusedStatusBar`), takes the
 * top of the screen under the status bar once the masthead has scrolled
 * away. `overlap={false}` starts the content below a band that ends with
 * its own content, such as the access PIN's. A focused field scrolls whole
 * above whatever follows the screen, such as an `ActionFooter`. A
 * `StickyFooterGroup` in the content pins its footer above the tab bar.
 */
export function ScrollScreen({
  children,
  masthead,
  collapsedHeader,
  refreshing = false,
  onRefresh,
  overlap = true,
  contentWidth,
}: {
  readonly children: ReactNode;
  /** The tab root's `Masthead`, drawn above the content. */
  readonly masthead?: ReactNode;
  /** Shown at the top while the masthead is scrolled out of view. */
  readonly collapsedHeader?: ReactNode;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
  /** Whether the first content overlaps the masthead's navy band. */
  readonly overlap?: boolean;
  readonly contentWidth?: ContentWidth;
}) {
  const insets = useSafeAreaInsets();
  const column = useContentColumn(contentWidth);
  const { isWide } = useViewport();
  const [mastheadHeight, setMastheadHeight] = useState<number>();
  const [collapsed, setCollapsed] = useState(false);
  const scrollView = useRef<ComponentRef<typeof ScrollView>>(null);
  // Instantly: a screen coming back into view shows its top right away.
  const sticky = useStickyFooterHost(scrollView, isWide);
  const { onScroll: stickyScroll } = sticky;
  const scrollToTop = useCallback(() => {
    scrollView.current?.scrollTo({ y: 0, animated: false });
    stickyScroll(0);
  }, [stickyScroll]);
  const focusedField = useFocusedFieldScroll(scrollView);
  const withMasthead = masthead !== undefined;
  const overlapping = withMasthead && overlap;
  const collapsing =
    collapsedHeader !== undefined && mastheadHeight !== undefined;
  return (
    <SafeAreaView edges={["left", "right"]} style={styles.screen}>
      <FocusedFieldContext value={focusedField.tracker}>
        <StickyFooterHostContext value={sticky.host}>
          <ScrollView
            ref={scrollView}
            onLayout={(event) => {
              focusedField.onLayout(event);
              sticky.onLayout(event);
            }}
            // Always set, for the same reason as a group's onLayout.
            onContentSizeChange={sticky.onContentSizeChange}
            // A tap on a button, or on a row of a sheet opened from this screen,
            // acts while the keyboard is up; elsewhere it closes the keyboard.
            // The responder system follows the React tree, so a modal sheet's
            // rows sit inside this ScrollView too.
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={
              collapsedHeader === undefined && !sticky.tracking ? undefined : 16
            }
            onScroll={
              !collapsing && !sticky.tracking
                ? undefined
                : (event) => {
                    const y = event.nativeEvent.contentOffset.y;
                    if (collapsing) setCollapsed(y >= mastheadHeight);
                    sticky.onScroll(y);
                  }
            }
            // A masthead clears the status bar itself.
            contentInsetAdjustmentBehavior={
              withMasthead ? "never" : "automatic"
            }
            refreshControl={
              onRefresh && (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={hiddenSpinner}
                  colors={[hiddenSpinner]}
                  progressBackgroundColor={hiddenSpinner}
                />
              )
            }
          >
            <ScrollScreenContext value={scrollToTop}>
              {masthead !== undefined && (
                <View
                  onLayout={(event) =>
                    setMastheadHeight(event.nativeEvent.layout.height)
                  }
                >
                  {masthead}
                </View>
              )}
              <View style={styles.page}>
                {overlapping && <View aria-hidden style={styles.overlap} />}
                <View
                  style={[
                    styles.content,
                    column,
                    isWide && { paddingBottom: insets.bottom + space.xxl },
                    overlapping && styles.overlapping,
                    withMasthead && !overlap && styles.belowBand,
                  ]}
                >
                  {children}
                </View>
              </View>
            </ScrollScreenContext>
          </ScrollView>
        </StickyFooterHostContext>
      </FocusedFieldContext>
      {sticky.pinned.size > 0 && (
        <PinnedFooters
          footers={sticky.pinned}
          bottom={sticky.pinBottom}
          left={insets.left}
        />
      )}
      {collapsed && collapsedHeader !== undefined && (
        <View style={[styles.collapsedHeader, { paddingTop: insets.top }]}>
          {collapsedHeader}
        </View>
      )}
      {refreshing && (
        <View
          style={[
            styles.refresh,
            // On the masthead's lower edge, clear of its title (board 10b).
            withMasthead &&
              mastheadHeight !== undefined && {
                top: mastheadHeight - refreshDiscSize / 2,
              },
          ]}
        >
          <View style={styles.refreshDisc}>
            <LoadingIndicator size="inline" tone="brand" />
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

/**
 * The screen's side of its sticky footers: where the content scrolled to,
 * the frames it measures them in, and the copies pinned over its bottom.
 * It follows the scroll only while a footer listens.
 */
function useStickyFooterHost(
  scrollView: RefObject<ComponentRef<typeof ScrollView> | null>,
  isWide: boolean
) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const frame = useRef({ scrollY: 0, viewportHeight: 0, belowScreen: 0 });
  const listeners = useRef(new Set<(change: "scroll" | "layout") => void>());
  const [tracking, setTracking] = useState(false);
  const [pinned, setPinned] = useState<ReadonlyMap<string, PinnedFooter>>(
    () => new Map()
  );
  // Clear of the tab bar's raised circle; with no tab bar, of the safe area.
  const pinBottom =
    (isWide ? insets.bottom : tabBarRaisedOverhang) + pinnedFooterGap;
  const notify = useCallback((change: "scroll" | "layout") => {
    for (const listener of listeners.current) listener(change);
  }, []);
  // Where the content has scrolled to, read from the viewport's and the
  // content's frames in the window (a footer can start listening after the
  // last scroll event), and how far the window runs on below this screen,
  // such as over the tab bar.
  const measureWindow = useCallback(() => {
    const view = scrollView.current;
    const viewport = view?.getNativeScrollRef();
    const content = view?.getInnerViewRef();
    if (!viewport || !content) return;
    viewport.measureInWindow((_x, top, _width, height) =>
      content.measureInWindow((_contentX, contentTop) => {
        frame.current.scrollY = top - contentTop;
        frame.current.viewportHeight = height;
        frame.current.belowScreen = Math.max(0, windowHeight - (top + height));
        notify("layout");
      })
    );
  }, [scrollView, windowHeight, notify]);
  const host = useMemo<StickyFooterHost>(
    () => ({
      // In the scrolled content's own frame, which its offset is read in.
      measure: (node, onBox) => {
        const relativeTo = scrollView.current?.getInnerViewRef();
        if (node === null || !relativeTo) return;
        node.measureLayout(relativeTo, (x, y, width, height) =>
          onBox({ x, y, width, height })
        );
      },
      pinLine: () =>
        frame.current.scrollY + frame.current.viewportHeight - pinBottom,
      belowPinned: () => frame.current.belowScreen + pinBottom,
      subscribe: (listener) => {
        listeners.current.add(listener);
        setTracking(true);
        measureWindow();
        return () => {
          listeners.current.delete(listener);
          setTracking(listeners.current.size > 0);
        };
      },
      pin: (key, footer) =>
        setPinned((current) => {
          if (footer === undefined && !current.has(key)) return current;
          const next = new Map(current);
          if (footer === undefined) next.delete(key);
          else next.set(key, footer);
          return next;
        }),
    }),
    [scrollView, pinBottom, measureWindow]
  );
  const onScroll = useCallback(
    (y: number) => {
      frame.current.scrollY = y;
      notify("scroll");
    },
    [notify]
  );
  return {
    host,
    tracking,
    pinned,
    pinBottom,
    onScroll,
    onLayout: (event: LayoutChangeEvent) => {
      frame.current.viewportHeight = event.nativeEvent.layout.height;
      if (listeners.current.size > 0) measureWindow();
    },
    onContentSizeChange: () => {
      if (listeners.current.size > 0) notify("layout");
    },
  };
}

/** The space between a pinned footer and what it sticks above. */
const pinnedFooterGap = space.md;

/** The refresh indicator's white disc. */
const refreshDiscSize = 40;

const styles = StyleSheet.create({
  screen: { backgroundColor: color.paper, flex: 1 },
  page: { width: "100%" },
  overlap: {
    backgroundColor: color.navy,
    height: mastheadOverlap,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  content: {
    gap: space.md,
    // The last control ends clear of the tab bar's raised circle.
    paddingBottom: space.xxl + tabBarRaisedOverhang,
    paddingTop: space.sm,
  },
  overlapping: { paddingTop: 0 },
  belowBand: { paddingTop: space.lg },
  collapsedHeader: {
    backgroundColor: color.paper,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  // The overlap less the gap the content's column adds after it.
  clearance: { height: mastheadOverlap - space.md },
  coveredFooter: { opacity: 0 },
  pinned: { position: "absolute" },
  belowPinned: {
    backgroundColor: color.paper,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
  },
  refresh: {
    alignItems: "center",
    left: 0,
    pointerEvents: "none",
    position: "absolute",
    right: 0,
    top: space.lg,
  },
  refreshDisc: {
    alignItems: "center",
    backgroundColor: color.surface,
    borderRadius: radius.pill,
    height: refreshDiscSize,
    justifyContent: "center",
    width: refreshDiscSize,
    ...shadow.refresh,
  },
});
