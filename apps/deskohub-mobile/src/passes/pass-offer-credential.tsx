import { useId } from "react";
import {
  Platform,
  Pressable,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import Svg, {
  ClipPath,
  Defs,
  G,
  Line,
  LinearGradient,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { iconHiddenProps } from "../ui/icon";
import { followLinkOnEnter } from "../ui/link-activation";
import { LogoMarkShape, logoMarkHeight } from "../ui/logo-mark";
import { Text } from "../ui/text";
import { color, radius, shadow, space } from "../ui/tokens";
import { PassOfferAction } from "./pass-offer-action";

/**
 * The Unlimited pass offer (board 00): a burgundy membership credential with
 * the issuer line, the Workspace logo in its photo area and the date the pass
 * would expire. One link to the Unlimited purchase.
 */
export function UnlimitedCredential({
  tagline,
  expiry,
  onPress,
}: {
  readonly tagline: string;
  /** The formatted date of expiry. */
  readonly expiry: string;
  readonly onPress: () => void;
}) {
  const locale = useAppLocale();
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= largeText;
  return (
    <Pressable
      role="link"
      onPress={onPress}
      onKeyDown={followLinkOnEnter(onPress)}
      style={({ pressed }) => [styles.credential, pressed && styles.pressed]}
    >
      <CredentialBackground />
      <View style={styles.issuer}>
        <Text variant="badge" style={styles.issuerName} balanced>
          {m.passes_offer_unlimited_issuer({}, { locale })}
        </Text>
        <GradientBar
          from={color.credentialLine}
          to={color.credentialLine}
          fade
          style={styles.issuerRule}
        />
        <FoilStripe />
      </View>
      <View style={[styles.identity, large && styles.identityLarge]}>
        <CredentialMark size={large ? 30 : 38} />
        <View style={styles.names}>
          <Text variant="offerTitle" style={styles.title} balanced>
            {m.passes_membership({}, { locale })}
          </Text>
          <Text variant="bodySmall" style={styles.quiet} balanced>
            {tagline}
          </Text>
        </View>
      </View>
      <View style={styles.footer}>
        <Text variant="offerExpiry" style={styles.expiry} balanced>
          {m.passes_offer_unlimited_expiry({ date: expiry }, { locale })}
        </Text>
        <PassOfferAction
          label={m.passes_offer_unlimited_action({}, { locale })}
          color={color.credentialAction}
          style={styles.action}
        />
      </View>
    </Pressable>
  );
}

/** At this font scale the photo area shrinks and moves up, as on the board. */
const largeText = 1.6;

/** The burgundy face: a diagonal gradient with a glow in the top right. */
function CredentialBackground() {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      pointerEvents="none"
      {...iconHiddenProps(Platform.OS)}
    >
      <Defs>
        <LinearGradient id={`${id}-face`} x1="0" y1="0" x2="0.37" y2="0.93">
          <Stop offset="0.05" stopColor={color.credentialTop} />
          <Stop offset="0.84" stopColor={color.credentialBase} />
        </LinearGradient>
        <RadialGradient
          id={`${id}-glow`}
          cx="1"
          cy="0"
          rx="1.41"
          ry="1.41"
          fx="1"
          fy="0"
        >
          <Stop offset="0" stopColor={color.credentialGlow} stopOpacity={1} />
          <Stop
            offset="0.58"
            stopColor={color.credentialGlow}
            stopOpacity={0}
          />
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id}-face)`} />
      <Rect width="100%" height="100%" fill={`url(#${id}-glow)`} />
    </Svg>
  );
}

/** A 1 dp line or a 4 dp stripe filled with a left-to-right gradient. */
function GradientBar({
  from,
  via,
  to,
  fade = false,
  style,
}: {
  readonly from: string;
  readonly via?: string;
  readonly to: string;
  /** Fade the gradient out towards the end. */
  readonly fade?: boolean;
  readonly style: StyleProp<ViewStyle>;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <View style={style}>
      <Svg width="100%" height="100%" {...iconHiddenProps(Platform.OS)}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0.27">
            <Stop offset="0" stopColor={from} />
            <Stop
              offset={via === undefined ? "0" : "0.55"}
              stopColor={via ?? from}
            />
            <Stop offset="1" stopColor={to} stopOpacity={fade ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" rx={2} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

function FoilStripe() {
  return (
    <GradientBar
      from={color.credentialFoilFirst}
      via={color.credentialFoilMid}
      to={color.credentialFoilLast}
      style={styles.foil}
    />
  );
}

/**
 * The credential's photo area: a hatched, softly tinted tile holding the
 * Workspace logo.
 */
function CredentialMark({ size }: { readonly size: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const height = size * 1.02;
  const inset = size >= 38 ? 7 : 5;
  const logoWidth = Math.min(size - 2 - 2 * inset, 48);
  const logoHeight = logoMarkHeight(logoWidth);
  // The board's hatching: 1 dp lines every 6 dp, rising to the right.
  const hatching = Array.from(
    { length: 2 * Math.ceil(size / 6) + 2 },
    (_, i) => {
      const offset = (i - Math.ceil(size / 6) - 1) * 6 * Math.SQRT2;
      return { x1: offset, y1: height, x2: offset + height, y2: 0 };
    }
  );
  return (
    <Svg width={size} height={height} {...iconHiddenProps(Platform.OS)}>
      <Defs>
        <LinearGradient id={`${id}-tint`} x1="0" y1="0" x2="0.74" y2="0.67">
          <Stop offset="0" stopColor={color.credentialBadgeStart} />
          <Stop offset="0.77" stopColor={color.credentialBadgeEnd} />
        </LinearGradient>
        <ClipPath id={`${id}-tile`}>
          <Rect width={size} height={height} rx={markCorner} />
        </ClipPath>
      </Defs>
      <Rect
        width={size}
        height={height}
        rx={markCorner}
        fill={`url(#${id}-tint)`}
      />
      <G clipPath={`url(#${id}-tile)`}>
        {hatching.map((line) => (
          <Line
            key={line.x1}
            {...line}
            stroke={color.credentialTexture}
            strokeWidth={1}
          />
        ))}
      </G>
      <Rect
        x={0.5}
        y={0.5}
        width={size - 1}
        height={height - 1}
        rx={markCorner - 0.5}
        fill="none"
        stroke={color.credentialBadgeEdge}
      />
      <LogoMarkShape
        x={(size - logoWidth) / 2}
        y={(height - logoHeight) / 2}
        width={logoWidth}
        color={color.credentialMark}
      />
    </Svg>
  );
}

const markCorner = 8;

const styles = StyleSheet.create({
  credential: {
    ...shadow.credential,
    backgroundColor: color.credentialBase,
    borderColor: color.credentialEdge,
    borderRadius: radius.group,
    borderWidth: 1,
    gap: 6,
    overflow: "hidden",
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  pressed: { opacity: 0.7 },
  issuer: { alignItems: "center", flexDirection: "row", gap: space.sm },
  issuerName: { color: color.credentialQuiet, flexShrink: 1 },
  issuerRule: { flex: 1, height: 1 },
  foil: { height: 4, width: 35 },
  identity: { alignItems: "center", flexDirection: "row", gap: 10 },
  identityLarge: { alignItems: "flex-start" },
  names: { flex: 1 },
  title: { color: color.credentialInk },
  quiet: { color: color.credentialQuiet },
  footer: {
    alignItems: "center",
    borderTopColor: color.credentialLine,
    borderTopWidth: 1,
    columnGap: space.sm,
    flexDirection: "row",
    flexWrap: "wrap",
    paddingTop: 6,
    rowGap: 6,
  },
  expiry: { color: color.credentialExpiry, flexGrow: 1, flexShrink: 1 },
  action: { marginLeft: "auto" },
});
