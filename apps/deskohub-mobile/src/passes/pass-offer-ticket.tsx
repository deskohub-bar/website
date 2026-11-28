import { useId, useState } from "react";
import {
  type LayoutRectangle,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { ClipPath, Defs, G, Line, Path, Rect } from "react-native-svg";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { iconHiddenProps } from "../ui/icon";
import { followLinkOnEnter } from "../ui/link-activation";
import { LogoMarkShape, logoMarkHeight } from "../ui/logo-mark";
import { Text } from "../ui/text";
import { color, space } from "../ui/tokens";
import { PassOfferAction } from "./pass-offer-action";
import type { EntryPackSizes } from "./pass-offers";

/**
 * The Entry pack offer (board 00): a perforated admission ticket whose stub
 * lists the visit counts on sale. One link to the Entry pack purchase.
 */
export function EntryPackTicket({
  sizes,
  onPress,
}: {
  /** One or two counts, smallest first. */
  readonly sizes: EntryPackSizes;
  readonly onPress: () => void;
}) {
  const locale = useAppLocale();
  const { fontScale } = useWindowDimensions();
  const [frame, setFrame] = useState<LayoutRectangle>();
  // The stub's drawn width: at least its share of the ticket, wider when a
  // translation's unit needs the room.
  const [stubFrame, setStubFrame] = useState<LayoutRectangle>();
  const stub = fontScale >= largeText ? largeStub : regularStub;
  const stubWidth = Math.max(stub.min, (frame?.width ?? 0) * stub.share);
  const [smaller, larger] = sizes;
  const count =
    smaller !== undefined && larger !== undefined
      ? m.passes_offer_entry_pack_sizes({ smaller, larger }, { locale })
      : sizes.join("");
  return (
    <Pressable
      role="link"
      onPress={onPress}
      onKeyDown={followLinkOnEnter(onPress)}
      onLayout={({ nativeEvent }) => setFrame(nativeEvent.layout)}
      style={({ pressed }) => [styles.ticket, pressed && styles.pressed]}
    >
      {frame !== undefined && stubFrame !== undefined && (
        <TicketArtwork
          width={frame.width}
          height={frame.height}
          fold={stubFrame.x}
        />
      )}
      <View style={styles.body}>
        <View>
          <Text variant="offerTitle" style={styles.title} balanced>
            {m.passes_entry_pack({}, { locale })}
          </Text>
          <Text variant="bodySmall" style={styles.tagline} balanced>
            {m.passes_offer_entry_pack_tagline({}, { locale })}
          </Text>
        </View>
        <PassOfferAction
          label={m.passes_offer_entry_pack_action({}, { locale })}
          color={color.ticketInk}
        />
      </View>
      <View
        onLayout={({ nativeEvent }) => setStubFrame(nativeEvent.layout)}
        style={[
          styles.stub,
          { minWidth: stubWidth, paddingHorizontal: stub.padding },
        ]}
      >
        <Text
          variant="offerCount"
          style={[styles.count, { maxWidth: stubWidth - 2 * stub.padding }]}
          balanced
        >
          {count}
        </Text>
        <Text variant="badge" style={styles.unit} balanced>
          {m.passes_offer_entry_pack_unit({}, { locale })}
        </Text>
      </View>
    </Pressable>
  );
}

/** At this font scale the stub widens, as the board's large text shows. */
const largeText = 1.6;
const regularStub = { min: 82, share: 0.27, padding: space.sm };
const largeStub = { min: 104, share: 0.31, padding: space.xs };

const edge = 1;
const corner = 11;
const notch = 9;

/**
 * The ticket's paper, drawn behind its text: the edge, the paper and stub
 * fills with the accent bar, the logo watermark and the perforation. Both
 * notches sit on the fold, at the top and bottom edges.
 */
function TicketArtwork({
  width,
  height,
  fold,
}: {
  readonly width: number;
  readonly height: number;
  /** Where the stub starts. */
  readonly fold: number;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const paper = `${id}-paper`;
  const body = `${id}-body`;
  const stubArea = `${id}-stub`;
  const mark = watermark(width, fold);
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width={width}
      height={height}
      pointerEvents="none"
      {...iconHiddenProps(Platform.OS)}
    >
      <Defs>
        <ClipPath id={paper}>
          <Path
            d={ticketOutline({
              left: edge,
              top: edge,
              right: width - edge,
              bottom: height - edge,
              corner: corner - edge,
              fold,
              notch: notch + edge,
              notchTop: 0,
              notchBottom: height,
            })}
          />
        </ClipPath>
        <ClipPath id={body}>
          <Rect x={0} y={0} width={fold} height={height} />
        </ClipPath>
        <ClipPath id={stubArea}>
          <Rect x={fold} y={0} width={width - fold} height={height} />
        </ClipPath>
      </Defs>
      <Path
        d={ticketOutline({
          left: 0,
          top: 0,
          right: width,
          bottom: height,
          corner,
          fold,
          notch,
          notchTop: 0,
          notchBottom: height,
        })}
        fill={color.ticketEdge}
      />
      <G clipPath={`url(#${paper})`}>
        <Rect
          x={0}
          y={0}
          width={fold}
          height={height}
          fill={color.ticketPaper}
        />
        <Rect
          x={fold}
          y={0}
          width={width - fold}
          height={height}
          fill={color.ticketStub}
        />
        <Rect
          x={0}
          y={0}
          width={edge + accentWidth}
          height={height}
          fill={color.ticketAccent}
        />
        <G clipPath={`url(#${body})`}>
          <LogoMarkShape {...mark} color={color.ticketWatermarkOnPaper} />
        </G>
        <G clipPath={`url(#${stubArea})`}>
          <LogoMarkShape {...mark} color={color.ticketWatermarkOnStub} />
        </G>
        <Line
          x1={fold}
          y1={perforationInset}
          x2={fold}
          y2={height - perforationInset}
          stroke={color.ticketPerforation}
          strokeWidth={2}
          strokeDasharray="4 3"
        />
      </G>
    </Svg>
  );
}

const accentWidth = 4;
const perforationInset = 11;

/**
 * The oversized logo behind the ticket, placed as the board places it. The
 * board sizes a square from a reference width that follows the card's, fits
 * the logo's full height into it, and puts the square so the logo straddles
 * the fold; the logo's apex stays about 22 dp from the top whatever the
 * card's height.
 */
const watermark = (width: number, fold: number) => {
  const reference = Math.min(152, Math.max(85, 0.37 * width));
  const square = (21 + 0.771 * reference) / 0.2725;
  const markWidth = square / logoMarkHeight(1);
  return {
    x: fold - 5 - 0.771 * reference - 0.229 * square + (square - markWidth) / 2,
    y: 22 - 0.21 * square,
    width: markWidth,
  };
};

/**
 * A rounded ticket outline with a semicircular notch cut into the top and
 * bottom edges at the fold. A notch's centre can sit outside the edge it
 * cuts, as the paper's does inside the 1 dp edge.
 */
const ticketOutline = ({
  left,
  top,
  right,
  bottom,
  corner,
  fold,
  notch,
  notchTop,
  notchBottom,
}: {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly corner: number;
  readonly fold: number;
  readonly notch: number;
  readonly notchTop: number;
  readonly notchBottom: number;
}) => {
  const topReach = Math.sqrt(notch ** 2 - (top - notchTop) ** 2);
  const bottomReach = Math.sqrt(notch ** 2 - (notchBottom - bottom) ** 2);
  return [
    `M ${left + corner} ${top}`,
    `H ${fold - topReach}`,
    `A ${notch} ${notch} 0 0 0 ${fold + topReach} ${top}`,
    `H ${right - corner}`,
    `A ${corner} ${corner} 0 0 1 ${right} ${top + corner}`,
    `V ${bottom - corner}`,
    `A ${corner} ${corner} 0 0 1 ${right - corner} ${bottom}`,
    `H ${fold + bottomReach}`,
    `A ${notch} ${notch} 0 0 0 ${fold - bottomReach} ${bottom}`,
    `H ${left + corner}`,
    `A ${corner} ${corner} 0 0 1 ${left} ${bottom - corner}`,
    `V ${top + corner}`,
    `A ${corner} ${corner} 0 0 1 ${left + corner} ${top}`,
    "Z",
  ].join(" ");
};

const styles = StyleSheet.create({
  ticket: { flexDirection: "row" },
  pressed: { opacity: 0.7 },
  body: {
    flex: 1,
    gap: space.sm,
    justifyContent: "space-between",
    paddingLeft: space.lg,
    paddingRight: space.md,
    paddingVertical: space.md,
  },
  title: { color: color.ticketInk },
  tagline: { color: color.ticketDetail, marginTop: space.xxs },
  stub: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: space.md,
  },
  count: { color: color.ticketInk, textAlign: "center" },
  unit: {
    color: color.ticketInk,
    letterSpacing: 1,
    marginTop: space.xs,
    textAlign: "center",
    textTransform: "uppercase",
  },
});
