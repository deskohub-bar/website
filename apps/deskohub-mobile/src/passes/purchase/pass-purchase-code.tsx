import Tag from "lucide-react-native/icons/tag";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { AppLocale } from "../../i18n/app-locale";
import { m } from "../../i18n/messages";
import { Button, TextField } from "../../ui/controls";
import { space } from "../../ui/tokens";

export function PassPurchaseCode({
  applied,
  busy,
  onUpdate,
  locale,
}: {
  readonly applied: string | undefined;
  readonly busy: boolean;
  readonly onUpdate: (code: string | undefined) => void;
  readonly locale: AppLocale;
}) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState("");
  const code = input.trim();
  const submit = () => {
    if (!busy && code !== "") onUpdate(code);
  };

  if (applied !== undefined) {
    return (
      <Button
        variant="text"
        width="content"
        label={m.booking_review_remove_code({ code: applied }, { locale })}
        onPress={() => {
          setInput("");
          onUpdate(undefined);
        }}
        disabled={busy}
      />
    );
  }

  if (!expanded) {
    return (
      <Button
        variant="text"
        width="content"
        icon={Tag}
        label={m.booking_review_add_code({}, { locale })}
        onPress={() => setExpanded(true)}
        disabled={busy}
      />
    );
  }

  return (
    <View style={styles.form}>
      <TextField
        label={m.booking_checkout_code_label({}, { locale })}
        value={input}
        onChangeText={setInput}
        onSubmitEditing={submit}
        returnKeyType="go"
        autoCapitalize="none"
        maxLength={64}
        editable={!busy}
      />
      <Button
        label={m.booking_checkout_code_apply({}, { locale })}
        variant="secondary"
        disabled={code === "" || busy}
        onPress={submit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.sm },
});
