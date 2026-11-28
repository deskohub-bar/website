import type {
  CustomerHeldEntryPack,
  CustomerHeldUnlimitedPass,
} from "@deskohub/workspace-customer-api";
import { useAtomValue } from "@effect/atom-react";
import CalendarPlus from "lucide-react-native/icons/calendar-plus";
import Gift from "lucide-react-native/icons/gift";
import KeyRound from "lucide-react-native/icons/key-round";
import { type ReactNode, useState } from "react";
import { StyleSheet, View } from "react-native";
import { bookingClockAtom } from "../booking/family/booking-clock";
import { daysBetween, pragueToday } from "../booking/selection/prague-date";
import { formatShortPragueDate } from "../booking/ui/prague-date-format";
import { useAppLocale } from "../i18n/locale-context";
import { m } from "../i18n/messages";
import { Badge } from "../ui/badge";
import { Button } from "../ui/controls";
import { Icon } from "../ui/icon";
import { Text } from "../ui/text";
import { color, radius, shadow, space, typeScale } from "../ui/tokens";
import { useViewport } from "../ui/viewport";
import { passDate, passPeriod, passTierName } from "./pass-copy";
import { MeterLegend, SegmentMeter } from "./pass-meters";

export function HeldEntryPackCard({
  pack,
  onBook,
}: {
  readonly pack: CustomerHeldEntryPack;
  readonly onBook: () => void;
}) {
  const locale = useAppLocale();
  const today = pragueToday(useAtomValue(bookingClockAtom));
  const booked = Math.min(
    pack.size - pack.entriesLeft,
    pack.bookedDates.length
  );
  const used = pack.size - pack.entriesLeft - booked;
  const next = pack.bookedDates[0];
  return (
    <PassCard
      pass={pack}
      product={m.passes_entry_pack({}, { locale })}
      size={m.passes_entries({ count: pack.size }, { locale })}
      badge={m.passes_active({}, { locale })}
      actions={
        pack.bookFrom === undefined ? undefined : (
          <Button
            label={m.passes_book_date({}, { locale })}
            icon={CalendarPlus}
            size="small"
            onPress={onBook}
          />
        )
      }
    >
      <Figure
        count={pack.entriesLeft}
        detail={m.passes_entries_left({ size: pack.size }, { locale })}
      />
      <View>
        <SegmentMeter
          spent={used}
          now={booked}
          left={pack.entriesLeft}
          label={m.booking_pass_left(
            { count: pack.entriesLeft, size: pack.size },
            { locale }
          )}
        />
        <MeterLegend
          items={[
            {
              part: "spent",
              label: m.passes_used({ count: used }, { locale }),
            },
            ...(booked > 0
              ? [
                  {
                    part: "now" as const,
                    label: m.passes_booked({ count: booked }, { locale }),
                  },
                ]
              : []),
            {
              part: "left",
              label: m.passes_to_book({ count: pack.entriesLeft }, { locale }),
            },
          ]}
        />
      </View>
      <View style={styles.facts}>
        <Fact
          title={m.passes_valid_until({}, { locale })}
          value={passDate(pack.lastUsableDate, locale)}
          detail={m.passes_in_days(
            { count: daysBetween(today, pack.lastUsableDate) },
            { locale }
          )}
        />
        <Fact
          title={m.passes_next_booking({}, { locale })}
          value={
            next === undefined
              ? m.passes_none_yet({}, { locale })
              : formatShortPragueDate(next, locale)
          }
          detail={
            next === undefined && pack.bookFrom !== undefined
              ? m.passes_any_open_day({}, { locale })
              : undefined
          }
        />
      </View>
    </PassCard>
  );
}

export function HeldUnlimitedPassCard({
  pass,
  onAccess,
  onRenew,
}: {
  readonly pass: CustomerHeldUnlimitedPass;
  readonly onAccess: () => void;
  readonly onRenew: () => void;
}) {
  const locale = useAppLocale();
  const day = pass.today;
  const total =
    day?.totalDays ?? daysBetween(pass.validFrom, pass.lastUsableDate) + 1;
  const left = day === undefined ? undefined : total - day.day + 1;
  const dayText =
    day === undefined
      ? undefined
      : m.passes_day_of({ day: day.day, total }, { locale });
  return (
    <PassCard
      pass={pass}
      product={m.passes_unlimited({}, { locale })}
      size={m.passes_days({ count: total }, { locale })}
      badge={
        dayText ??
        (pass.status === "upcoming"
          ? m.passes_upcoming({}, { locale })
          : m.passes_active({}, { locale }))
      }
      actions={
        ((day !== undefined || pass.renewalPath !== undefined) && (
          <>
            {day !== undefined && (
              <Button
                label={m.passes_door_code({}, { locale })}
                icon={KeyRound}
                size="small"
                onPress={onAccess}
              />
            )}
            {pass.renewalPath !== undefined && (
              <Button
                label={m.passes_renew({}, { locale })}
                variant="secondary"
                size="small"
                onPress={onRenew}
              />
            )}
          </>
        )) ||
        undefined
      }
    >
      {day !== undefined && left !== undefined && (
        <>
          <Figure
            count={left}
            detail={m.passes_today_included({ count: left }, { locale })}
          />
          <View>
            <UnlimitedDayMeter day={day.day} total={total} />
            <MeterLegend
              items={[
                {
                  part: "spent",
                  label: m.passes_days_gone({ count: day.day - 1 }, { locale }),
                },
                { part: "now", label: m.passes_today({}, { locale }) },
                {
                  part: "left",
                  label: m.passes_days_to_come({ count: left - 1 }, { locale }),
                },
              ]}
            />
          </View>
        </>
      )}
      <View style={styles.facts}>
        <Fact
          title={m.passes_period({}, { locale })}
          value={passPeriod(pass.validFrom, pass.lastUsableDate, locale)}
          detail={
            left === undefined
              ? undefined
              : m.passes_ends_in({ count: left - 1 }, { locale })
          }
        />
        <Fact
          title={m.passes_where({}, { locale })}
          value={pass.seatLabel ?? m.passes_any_free_desk({}, { locale })}
          detail={
            pass.seatLabel === undefined
              ? m.passes_no_booking({}, { locale })
              : m.passes_same_desk({}, { locale })
          }
        />
      </View>
    </PassCard>
  );
}

export function UnlimitedDayMeter({
  day,
  total,
}: {
  readonly day: number;
  readonly total: number;
}) {
  const locale = useAppLocale();
  return (
    <SegmentMeter
      thin
      spent={day - 1}
      now={1}
      left={total - day}
      label={m.passes_day_of({ day, total }, { locale })}
    />
  );
}

function PassCard({
  pass,
  product,
  size,
  badge,
  actions,
  children,
}: {
  readonly pass: CustomerHeldEntryPack | CustomerHeldUnlimitedPass;
  readonly product: string;
  readonly size: string;
  readonly badge: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const locale = useAppLocale();
  const { fontScale } = useViewport();
  const stacked = fontScale >= 1.3;
  const hasPurchase = pass.gift !== undefined || pass.boughtOn !== undefined;
  return (
    <View style={styles.card}>
      <View style={styles.body}>
        <View style={[styles.head, stacked && styles.stackedHead]}>
          {hasPurchase && (
            <View style={[styles.meta, stacked && styles.metaAlone]}>
              {pass.gift !== undefined && (
                <View style={styles.giftLine}>
                  <View
                    style={{
                      height: typeScale.caption.lineHeight * fontScale,
                      justifyContent: "center",
                    }}
                  >
                    <Icon icon={Gift} size={14} color={color.action} />
                  </View>
                  <Text variant="caption" tone="subtle" style={styles.metaText}>
                    {pass.gift.buyerName === undefined
                      ? m.passes_gifted({}, { locale })
                      : m.passes_gifted_by(
                          { name: pass.gift.buyerName },
                          { locale }
                        )}
                  </Text>
                </View>
              )}
              {pass.boughtOn !== undefined && (
                <Text variant="caption" tone="subtle" style={styles.metaText}>
                  {m.passes_bought(
                    { date: passDate(pass.boughtOn, locale) },
                    { locale }
                  )}
                </Text>
              )}
            </View>
          )}
          <View style={styles.heading}>
            <PassProductLabel product={product} size={size} />
            <Text variant="title">{passTierName(pass.tier, locale)}</Text>
            <View style={styles.badge}>
              <Badge label={badge} tone="positive" />
            </View>
          </View>
        </View>
        {children}
      </View>
      {actions !== undefined && <View style={styles.footer}>{actions}</View>}
    </View>
  );
}

function PassProductLabel({
  product,
  size,
}: {
  readonly product: string;
  readonly size: string;
}) {
  const { availableWidth, fontScale } = useViewport();
  const layout = `${availableWidth}/${fontScale}/${product}/${size}`;
  const [wrappedAt, setWrappedAt] = useState<string>();
  if (wrappedAt === layout) {
    return (
      <View>
        <Text variant="caption" style={styles.eyebrow}>
          {product}
        </Text>
        <Text variant="caption" style={styles.eyebrow}>
          {size}
        </Text>
      </View>
    );
  }
  return (
    <Text
      variant="caption"
      style={styles.eyebrow}
      onTextLayout={({ nativeEvent }) => {
        if (nativeEvent.lines.length > 1) setWrappedAt(layout);
      }}
    >
      {product} · {size}
    </Text>
  );
}

function Figure({
  count,
  detail,
}: {
  readonly count: number;
  readonly detail: string;
}) {
  return (
    <View style={styles.figure}>
      <Text variant="display" numeric>
        {count}
      </Text>
      <Text variant="headline" style={styles.figureDetail}>
        {detail}
      </Text>
    </View>
  );
}

function Fact({
  title,
  value,
  detail,
}: {
  readonly title: string;
  readonly value: string;
  readonly detail?: string | undefined;
}) {
  return (
    <View style={styles.fact}>
      <Text variant="caption" tone="subtle" style={styles.uppercase}>
        {title}
      </Text>
      <Text variant="bodyStrong">{value}</Text>
      {detail !== undefined && (
        <Text variant="hint" tone="muted">
          {detail}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.line,
    ...shadow.card,
  },
  body: { gap: space.lg, padding: space.lg },
  head: {
    flexDirection: "row-reverse",
    gap: space.sm,
    justifyContent: "space-between",
  },
  stackedHead: { flexDirection: "column" },
  heading: { flexShrink: 1, flexGrow: 1, gap: space.xs },
  eyebrow: {
    color: color.positiveInk,
    letterSpacing: 1,
    textTransform: "uppercase",
    flexShrink: 1,
  },
  badge: { alignItems: "flex-start", marginTop: space.xs },
  meta: { flexShrink: 1, maxWidth: "43%", alignItems: "flex-end" },
  metaAlone: { maxWidth: "100%" },
  metaText: { textAlign: "right", flexShrink: 1 },
  giftLine: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "flex-end",
    gap: space.xxs,
  },
  figure: {
    alignItems: "baseline",
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: space.sm,
  },
  figureDetail: { flexShrink: 1 },
  facts: {
    borderTopWidth: 1,
    borderTopColor: color.divider,
    paddingTop: space.md,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.md,
  },
  fact: { flexBasis: 128, flexGrow: 1, gap: space.xxs },
  uppercase: { textTransform: "uppercase" },
  footer: {
    backgroundColor: color.sunken,
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
    padding: space.lg,
    gap: space.sm,
  },
});
