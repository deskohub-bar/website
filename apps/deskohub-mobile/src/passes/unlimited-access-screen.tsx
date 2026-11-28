import {
  CustomerReservationOrderId,
  type CustomerUnlimitedAccess,
} from "@deskohub/workspace-customer-api";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { DateTime } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { Stack, useFocusEffect, useIsFocused } from "expo-router";
import DoorOpen from "lucide-react-native/icons/door-open";
import { useCallback, useEffect, useRef } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { secondClock } from "../account/reservations/access-clock";
import { accessPinGroups } from "../account/reservations/access-pin-groups";
import { CopyPin, PinDigits } from "../account/reservations/access-screen";
import { pragueToday } from "../booking/selection/prague-date";
import {
  formatPragueTimeAt,
  formatShortPragueDate,
} from "../booking/ui/prague-date-format";
import { AsyncView } from "../customer-api/async-view";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { Card } from "../ui/card";
import { Button } from "../ui/controls";
import { Icon } from "../ui/icon";
import { StackHeader } from "../ui/navigation";
import { Notice } from "../ui/notice";
import { ScrollScreen } from "../ui/scroll-screen";
import { Text } from "../ui/text";
import { color, radius, space } from "../ui/tokens";
import { UnlimitedDayMeter } from "./held-pass-cards";
import { passDate, passTierName } from "./pass-copy";
import { unlimitedAccessAtom } from "./pass-reads";

const accessClockAtom = Atom.map(Atom.make(secondClock), (result) =>
  DateTime.toEpochMillis(AsyncResult.getOrElse(result, DateTime.nowUnsafe))
);

export function UnlimitedAccessScreen({
  passId,
}: {
  readonly passId: string | undefined;
}) {
  return passId === undefined ? (
    <MissingPass />
  ) : (
    <HeldUnlimitedAccess passId={passId} />
  );
}

function MissingPass() {
  const locale = useAppLocale();
  return (
    <ScrollScreen>
      <Stack.Screen options={{ title: m.passes_door_code({}, { locale }) }} />
      <Notice tone="error" message={m.passes_not_found({}, { locale })} />
    </ScrollScreen>
  );
}

function HeldUnlimitedAccess({ passId }: { readonly passId: string }) {
  const locale = useAppLocale();
  const atom = unlimitedAccessAtom(passId);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const focused = useIsFocused();
  const loadedInView = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (loadedInView.current) refresh();
      loadedInView.current = true;
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => subscription.remove();
    }, [refresh])
  );
  const now = useAtomValue(accessClockAtom);
  const value = AsyncResult.isSuccess(result) ? result.value : undefined;
  const today = pragueToday(new Date(now));
  const needsNextDay =
    value !== undefined && "date" in value && value.date < today;
  const expiration =
    value?.state === "available" ? Date.parse(value.endsAt) : undefined;
  const expired =
    expiration !== undefined &&
    (!Number.isFinite(expiration) || expiration <= now);
  const canShow =
    focused &&
    !result.waiting &&
    value?.state === "available" &&
    value.date === today &&
    expiration !== undefined &&
    expiration > now;

  const starting = value?.state === "before-start" && value.validFrom <= today;
  const notice =
    value === undefined || canShow
      ? undefined
      : {
          available: () => m.passes_access_refresh({}, { locale }),
          "before-start": () =>
            m.passes_starts_on(
              { date: passDate(value.validFrom, locale) },
              { locale }
            ),
          ended: () => m.passes_ended({}, { locale }),
          closed: () => m.passes_access_closed({}, { locale }),
          retry: () => m.passes_access_refresh({}, { locale }),
        }[value.state]();

  // Refresh once when the displayed code or day ends. The old code is
  // already hidden while the request is in flight.
  useEffect(() => {
    if (expired || needsNextDay || starting) refresh();
  }, [expired, needsNextDay, refresh, starting]);

  return (
    <>
      <Stack.Screen
        options={{
          title: m.passes_door_code({}, { locale }),
          header: (props) => (
            <StackHeader
              {...props}
              tone={canShow ? "navy" : "paper"}
              backFallback="/account/passes"
            />
          ),
        }}
      />
      <ScrollScreen
        overlap={false}
        refreshing={result.waiting && !AsyncResult.isInitial(result)}
        onRefresh={refresh}
        masthead={canShow ? <DoorCodeBand access={value} /> : undefined}
      >
        <AsyncView
          result={result}
          onRetry={refresh}
          errorMessage={(error) =>
            error._tag === "NotFound" || error._tag === "FeatureUnavailable"
              ? m.passes_not_found({}, { locale })
              : undefined
          }
        >
          {() =>
            value !== undefined && (
              <>
                <Notice tone="info" message={notice} />
                {"day" in value && <PassAccessPeriod access={value} />}
                {(expired || needsNextDay || value.state === "retry") && (
                  <Button
                    label={m.account_retry({}, { locale })}
                    disabled={result.waiting}
                    onPress={refresh}
                  />
                )}
              </>
            )
          }
        </AsyncView>
      </ScrollScreen>
    </>
  );
}

function DoorCodeBand({
  access,
}: {
  readonly access: Extract<CustomerUnlimitedAccess, { state: "available" }>;
}) {
  const locale = useAppLocale();
  const end = new Date(access.endsAt);
  return (
    <View style={styles.hero}>
      <View style={styles.heroHead}>
        <Text variant="body" style={styles.heading}>
          {m.passes_product_tier(
            {
              product: m.passes_unlimited({}, { locale }),
              tier: passTierName(access.tier, locale),
            },
            { locale }
          )}
        </Text>
        <CopyPin
          orderId={CustomerReservationOrderId.make(access.passId)}
          code={access.code}
        />
      </View>
      <PinDigits groups={accessPinGroups(access.code)} />
      <View style={styles.how}>
        <Icon icon={DoorOpen} size={16} color={color.onNavyMuted} />
        <Text variant="hint" style={styles.howText}>
          {m.passes_keypad({}, { locale })}
        </Text>
      </View>
      <View style={styles.chip}>
        <View aria-hidden style={styles.dot} />
        <Text variant="label" style={styles.chipLabel}>
          {m.passes_valid_today(
            {
              date: formatShortPragueDate(access.date, locale),
              time:
                pragueToday(end) > access.date
                  ? m.passes_midnight({}, { locale })
                  : formatPragueTimeAt(end, locale),
            },
            { locale }
          )}
        </Text>
      </View>
    </View>
  );
}

function PassAccessPeriod({
  access,
}: {
  readonly access: Extract<CustomerUnlimitedAccess, { day: number }>;
}) {
  const locale = useAppLocale();
  return (
    <Card>
      <View style={styles.period}>
        {access.state === "available" && access.deskLabel !== undefined && (
          <View style={styles.desk}>
            <Text variant="caption" style={styles.deskLabel}>
              {m.passes_your_desk({}, { locale })}
            </Text>
            <Text variant="display" numeric>
              {access.deskLabel}
            </Text>
          </View>
        )}
        <View style={styles.days}>
          <Text variant="headline">
            {m.passes_day_of(
              { day: access.day, total: access.totalDays },
              { locale }
            )}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {m.passes_ends_on(
              { date: passDate(access.lastUsableDate, locale, false) },
              { locale }
            )}
          </Text>
          <View style={styles.meter}>
            <UnlimitedDayMeter day={access.day} total={access.totalDays} />
          </View>
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: space.md,
    padding: space.gutter,
    paddingBottom: space.xl,
    backgroundColor: color.navy,
  },
  heroHead: { flexDirection: "row", alignItems: "center" },
  heading: { flex: 1, textAlign: "center", color: color.onNavyMuted },
  how: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    columnGap: space.sm,
  },
  howText: { color: color.onNavyMuted, flexShrink: 1, textAlign: "center" },
  chip: {
    alignSelf: "center",
    alignItems: "center",
    flexDirection: "row",
    columnGap: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.positive,
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
  },
  chipLabel: { flexShrink: 1, color: color.onPositive, textAlign: "center" },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.positiveInk,
  },
  period: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.lg,
    alignItems: "center",
  },
  desk: {
    alignItems: "center",
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: color.positive,
    backgroundColor: color.positiveTint,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  deskLabel: {
    color: color.positiveInk,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  days: { flexBasis: 160, flexGrow: 1, gap: space.xxs },
  meter: { marginTop: space.sm },
});
