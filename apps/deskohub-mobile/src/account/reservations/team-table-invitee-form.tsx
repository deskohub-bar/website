import type { CustomerReservationOrderId } from "@deskohub/workspace-customer-api";
import { useAtomSet } from "@effect/atom-react";
import { Cause, Exit, Option } from "effect";
import Plus from "lucide-react-native/icons/plus";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { isEmailAddress } from "../../auth/email-address";
import { viewErrorOf } from "../../customer-api/customer-view-error";
import { sharedViewErrorMessage } from "../../customer-api/customer-view-error-message";
import { useAppLocale } from "../../i18n/locale-context";
import { m } from "../../i18n/messages";
import { Button, TextField } from "../../ui/controls";
import { Text } from "../../ui/text";
import { useToast } from "../../ui/toast";
import { space } from "../../ui/tokens";
import { addTeamTableInviteeAtom } from "./team-table-invitees";

export function TeamTableInviteeForm({
  orderId,
  endsAt,
  refreshing,
  onRefresh,
}: {
  readonly orderId: CustomerReservationOrderId;
  readonly endsAt: number | undefined;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const locale = useAppLocale();
  const toast = useToast();
  const addInvitee = useAtomSet(addTeamTableInviteeAtom(orderId), {
    mode: "promiseExit",
  });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [now, setNow] = useState(Date.now);
  const open = endsAt !== undefined && endsAt > now;
  useEffect(() => {
    if (!open) return;
    // The booking can be months away. Recheck before a JS timeout overflows.
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(endsAt - now, 2_147_483_647)
    );
    return () => clearTimeout(timer);
  }, [endsAt, now, open]);

  const submit = async () => {
    if (sending.current || refreshing || endsAt === undefined) return;
    if (endsAt <= Date.now()) {
      setNow(Date.now());
      return;
    }
    const candidate = email.trim();
    if (!isEmailAddress(candidate)) {
      setError(m.booking_office_person_email_invalid({}, { locale }));
      return;
    }
    setError(undefined);
    sending.current = true;
    setBusy(true);
    try {
      const exit = await addInvitee({ locale, email: candidate });
      if (Exit.isFailure(exit)) {
        if (
          Option.exists(
            Cause.findErrorOption(exit.cause),
            (error) => error._tag === "CustomerWriteUnconfirmed"
          )
        )
          onRefresh();
        setError(
          sharedViewErrorMessage(viewErrorOf(exit.cause), locale) ??
            m.account_error_unexpected({}, { locale })
        );
        return;
      }
      switch (exit.value) {
        case "added":
          setEmail("");
          toast.show({
            message: m.reservations_table_invitee_added(
              { email: candidate },
              { locale }
            ),
            tone: "confirmation",
          });
          onRefresh();
          break;
        case "not-confirmed":
        case "ended":
          setError(m.reservations_table_invitee_closed({}, { locale }));
          onRefresh();
          break;
        case "capacity":
          setError(m.reservations_table_invitee_capacity({}, { locale }));
          onRefresh();
          break;
        case "duplicate":
          setError(m.reservations_table_invitee_duplicate({}, { locale }));
          onRefresh();
          break;
        case "invalid-email":
          setError(m.booking_office_person_email_invalid({}, { locale }));
          break;
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  if (!open) {
    return error === undefined ? null : (
      <Text variant="hint" tone="danger" role="alert">
        {error}
      </Text>
    );
  }
  return (
    <View style={styles.form}>
      <TextField
        label={m.booking_office_person_email_label({}, { locale })}
        value={email}
        onChangeText={(value) => {
          setEmail(value);
          setError(undefined);
        }}
        onSubmitEditing={() => void submit()}
        keyboardType="email-address"
        inputMode="email"
        autoComplete="email"
        textContentType="emailAddress"
        autoCapitalize="none"
        returnKeyType="done"
        maxLength={255}
        editable={!busy}
        error={error}
      />
      <Button
        variant="secondary"
        icon={Plus}
        label={m.reservations_table_add_invitee({}, { locale })}
        busy={busy}
        disabled={refreshing || email.trim() === ""}
        onPress={() => void submit()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.sm },
});
