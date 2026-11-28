import type { CustomerPassCatalog } from "@deskohub/workspace-customer-api";
import Interpolate from "@doist/react-interpolate";
import { useRouter } from "expo-router";
import { Pressable, StyleSheet } from "react-native";
import type { CoworkDraft } from "../booking/selection/cowork-selection";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { Text } from "../ui/text";
import { color, space, touchTarget } from "../ui/tokens";
import { cheapestPackDay } from "./pass-copy";
import { entryPackHrefForDraft } from "./pass-routes";

export function EntryPackOfferLink({
  catalog,
  draft,
}: {
  readonly catalog: CustomerPassCatalog;
  readonly draft: CoworkDraft;
}) {
  const locale = useAppLocale();
  const router = useRouter();
  const price = cheapestPackDay(catalog, locale);
  if (price === undefined) return null;
  return (
    <Pressable
      role="link"
      onPress={() => router.push(entryPackHrefForDraft(draft))}
      style={({ pressed }) => [styles.link, pressed && styles.pressed]}
    >
      <Text variant="bodySmall" tone="muted">
        <Interpolate
          string={m.booking_pass_buy_link({ price }, { locale })}
          mapping={{
            packLink: <Text variant="bodySmall" style={styles.strong} />,
          }}
        />
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  link: {
    justifyContent: "center",
    minHeight: touchTarget,
    paddingTop: space.xs,
  },
  pressed: { opacity: 0.7 },
  strong: {
    color: color.navy,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
});
