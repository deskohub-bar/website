import type { CustomerHeldUnlimitedPass } from "@deskohub/workspace-customer-api";
import { useRouter } from "expo-router";
import CalendarRange from "lucide-react-native/icons/calendar-range";
import KeyRound from "lucide-react-native/icons/key-round";
import { StyleSheet, View } from "react-native";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { Button } from "../ui/controls";
import { Icon } from "../ui/icon";
import { Text } from "../ui/text";
import { color, radius, shadow, space } from "../ui/tokens";
import { UnlimitedDayMeter } from "./held-pass-cards";
import { passPeriod, passTierName } from "./pass-copy";
import { unlimitedAccessHref } from "./pass-routes";

export function UnlimitedPeriodItem({
  pass,
}: {
  readonly pass: CustomerHeldUnlimitedPass;
}) {
  const locale = useAppLocale();
  const router = useRouter();
  const past = pass.status === "expired" || pass.status === "ended";
  const today = past ? undefined : pass.today;
  const period = passPeriod(pass.validFrom, pass.lastUsableDate, locale);
  const tier = passTierName(pass.tier, locale);
  return (
    <View style={[styles.period, past && styles.past]}>
      <View style={styles.head}>
        <View style={styles.tile}>
          <Icon icon={CalendarRange} size={20} color={color.positiveInk} />
          {today !== undefined && (
            <Text variant="caption" numeric style={styles.eyebrow}>
              {m.passes_day_fraction(
                { day: today.day, total: today.totalDays },
                { locale }
              )}
            </Text>
          )}
        </View>
        <View style={styles.text}>
          <Text variant="caption" style={styles.eyebrow}>
            {m.passes_unlimited({}, { locale })}
          </Text>
          <Text variant="headline">
            {pass.seatLabel === undefined
              ? tier
              : m.passes_tier_desk({ tier, desk: pass.seatLabel }, { locale })}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {today === undefined
              ? period
              : m.passes_day_period(
                  {
                    day: m.passes_day_of(
                      { day: today.day, total: today.totalDays },
                      { locale }
                    ),
                    period,
                  },
                  { locale }
                )}
          </Text>
        </View>
      </View>
      {today !== undefined && (
        <>
          <UnlimitedDayMeter day={today.day} total={today.totalDays} />
          <Text variant="hint" tone="muted">
            {m.passes_days_remaining(
              { count: today.totalDays - today.day + 1 },
              { locale }
            )}
          </Text>
          <Button
            label={m.passes_door_code({}, { locale })}
            icon={KeyRound}
            size="small"
            onPress={() => router.push(unlimitedAccessHref(pass.passId))}
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  period: {
    backgroundColor: color.surface,
    borderColor: color.positive,
    borderRadius: radius.card,
    borderWidth: 1,
    gap: space.md,
    padding: space.lg,
    ...shadow.card,
  },
  past: { borderColor: color.line },
  head: { columnGap: space.md, flexDirection: "row" },
  tile: {
    alignItems: "center",
    backgroundColor: color.positiveTint,
    borderRadius: radius.tile,
    gap: space.xxs,
    justifyContent: "center",
    minHeight: 64,
    minWidth: 64,
    paddingHorizontal: space.sm,
  },
  text: { flex: 1, gap: space.xxs },
  eyebrow: { color: color.positiveInk, textTransform: "uppercase" },
});
