import ChevronRight from "lucide-react-native/icons/chevron-right";
import { useState } from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  type TextStyle,
  View,
} from "react-native";
import { apiOrigin } from "../../auth/auth-client";
import { useAppLocale } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { PassProductMarks } from "../../passes/pass-product-marks";
import { openSitePage } from "../../routing/open-site-page";
import { sitePageUrl } from "../../routing/site-page";
import { Icon } from "../../ui/icon";
import { followLinkOnEnter } from "../../ui/link-activation";
import { useIsHiddenStickyCopy } from "../../ui/scroll-screen";
import { Text } from "../../ui/text";
import { useToast } from "../../ui/toast";
import { color, space } from "../../ui/tokens";
import { useViewport } from "../../ui/viewport";

/**
 * The Past group's last row (board 06): the two product marks and "Save
 * with packs and passes", opening the site's Pricing page in the in-app
 * browser. Past reservations hold no booking to carry there, so the page
 * opens unselected. When the label has little room for its text size (large
 * text, or a zoomed web page) it moves under the marks.
 */
export function PastSavingsFooter() {
  const locale = useAppLocale();
  const toast = useToast();
  const hiddenCopy = useIsHiddenStickyCopy();
  const { fontScale } = useViewport();
  const [width, setWidth] = useState<number>();
  // The web reports no font scale, but a zoomed page leaves less width.
  const stacked = width !== undefined && width / fontScale < stackedBelowWidth;
  const label = m.reservations_save_with_passes({}, { locale });
  const open = () =>
    openSitePage(sitePageUrl("/pricing", apiOrigin, locale), {
      failIfBlocked: true,
    }).catch(() =>
      toast.show({
        message: m.reservations_pricing_open_failed({}, { locale }),
        tone: "neutral",
      })
    );
  return (
    <Pressable
      role="link"
      aria-label={label}
      // Keyboard focus reaches only the copy in sight while the row is pinned.
      focusable={!hiddenCopy}
      tabIndex={hiddenCopy ? -1 : 0}
      onPress={open}
      onKeyDown={followLinkOnEnter(open)}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={({ pressed }) => [styles.footer, pressed && styles.pressed]}
    >
      <View
        style={stacked ? styles.stackedText : [styles.inlineText, wrappingWeb]}
      >
        <PassProductMarks />
        <Text
          variant="bodyStrong"
          tone="action"
          textBreakStrategy="balanced"
          style={[styles.label, balancedWeb]}
        >
          {label}
        </Text>
      </View>
      <Icon icon={ChevronRight} size={20} color={color.action} />
    </Pressable>
  );
}

/**
 * The row's width, at default text size, under which its label stacks: at
 * 360 dp that is from about 130% text.
 */
const stackedBelowWidth = 260;

// Balanced lines, as the board's text-wrap: balance (Android balances
// through textBreakStrategy). A web browser can enlarge text without a
// font scale or a narrower page, so there the row also wraps the label
// under the marks once it would get less than 9.5 of its ems (from about
// 135% text at 360 dp).
const balancedWeb =
  Platform.OS === "web"
    ? ({
        textWrap: "balance",
        flexBasis: 0,
        flexGrow: 1,
        // Never wider than the column, where it already sits alone.
        minWidth: "min(9.5em, 100%)",
      } as TextStyle)
    : undefined;
const wrappingWeb =
  Platform.OS === "web"
    ? ({ columnGap: 10, flexWrap: "wrap", rowGap: 5 } as const)
    : undefined;

const styles = StyleSheet.create({
  footer: {
    alignItems: "center",
    backgroundColor: color.paper,
    borderTopColor: color.line,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  pressed: { backgroundColor: color.sunken },
  inlineText: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 10,
    minWidth: 0,
  },
  stackedText: { alignItems: "flex-start", flex: 1, gap: 5, minWidth: 0 },
  label: { flexShrink: 1 },
});
