import type {
  CustomerLegalDocument,
  CustomerPassPurchaseDisclosure,
} from "@deskohub/workspace-customer-api";
import Interpolate from "@doist/react-interpolate";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { apiOrigin } from "../../auth/auth-client";
import type { AppLocale } from "../../i18n/app-locale";
import { m } from "../../i18n/messages";
import { openSitePage } from "../../routing/open-site-page";
import { Checkbox } from "../../ui/checkbox";
import { Text } from "../../ui/text";
import { color, space, touchTarget } from "../../ui/tokens";

export const hasPassLegalDocuments = (
  disclosure: CustomerPassPurchaseDisclosure
) =>
  disclosure.documents.length === 2 &&
  disclosure.documents.every(({ hash }) => hash.length > 0) &&
  disclosure.documents.some(({ key }) => key === "terms-and-conditions") &&
  disclosure.documents.some(({ key }) => key === "operating-rules");

export function PassPurchaseAgreement({
  disclosure,
  checked,
  disabled,
  onToggle,
  locale,
}: {
  readonly disclosure: CustomerPassPurchaseDisclosure;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
  readonly locale: AppLocale;
}) {
  if (!hasPassLegalDocuments(disclosure)) {
    return (
      <Text tone="muted">
        {m.booking_checkout_legal_failed({}, { locale })}
      </Text>
    );
  }
  const link = (key: CustomerLegalDocument["key"]) => {
    const document = disclosure.documents.find(
      (candidate) => candidate.key === key
    );
    return (label: ReactNode) => (
      <Text
        role="link"
        style={styles.link}
        onPress={(event) => {
          event.stopPropagation();
          if (document === undefined) return;
          const url = new URL(document.path, apiOrigin);
          if (url.origin === apiOrigin) void openSitePage(url.href);
        }}
      >
        {label}
      </Text>
    );
  };
  const sentence = m.booking_checkout_legal_consent({}, { locale });
  const earlyStart = disclosure.earlyStartRequest;
  return (
    <View style={styles.agreement}>
      <Pressable
        role="checkbox"
        aria-checked={checked}
        aria-disabled={disabled}
        aria-label={[sentence.replace(/<\/?[A-Za-z]+>/g, ""), earlyStart]
          .filter(Boolean)
          .join(" ")}
        disabled={disabled}
        onPress={onToggle}
        style={styles.agreementBox}
      >
        <Checkbox checked={checked} disabled={disabled} />
      </Pressable>
      <Text
        variant="hint"
        style={styles.agreementText}
        onPress={disabled ? undefined : onToggle}
      >
        <Interpolate
          string={sentence}
          mapping={{
            terms: link("terms-and-conditions"),
            operatingRules: link("operating-rules"),
          }}
        />
        {earlyStart === undefined ? "" : ` ${earlyStart}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  agreement: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  agreementBox: {
    minWidth: touchTarget,
    minHeight: touchTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  agreementText: { flex: 1, paddingVertical: space.sm },
  link: { color: color.navy, textDecorationLine: "underline" },
});
