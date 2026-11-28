import type {
  CustomerReservationFamily,
  CustomerTeamTableOfferings,
} from "@deskohub/workspace-customer-api";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import type { AppLocale } from "../../i18n/app-locale";
import { m } from "../../i18n/messages";
import { formatMoney } from "../../i18n/money-format";
import { Skeleton, SkeletonGroup } from "../../ui/skeleton";
import { Text } from "../../ui/text";
import { brandText, color, radius, shadow, space } from "../../ui/tokens";
import { contentColumnWidth, useViewport, wideGutter } from "../../ui/viewport";
import type { BookingFamily } from "../selection/booking-selection";
import { SpaceIllustration } from "../ui/space-illustration";
import { familyTitle } from "./booking-family-copy";
import {
  type SpaceCard,
  type SpaceFacts,
  type SpaceRow,
  type SpaceUnit,
  spaceColumnsFit,
  spaceRows,
} from "./space-chooser";
import {
  teamTableCapacities,
  teamTableCapacityLabel,
  teamTableRateLabel,
} from "./team-table-offerings";

/** The board's picture heights: a half-width and a full-width card. */
const pictureHeight = { half: 104, full: 148 } as const;
/** A half card's text inset on each side. */
const halfPadding = 10;
/** The loaded cards and the skeleton use the same width and text budget. */
const useSpaceGrid = () => {
  const { width, availableWidth, fontScale, isWide, isExpanded } =
    useViewport();
  const contentWidth = isWide
    ? Math.min(availableWidth - 2 * wideGutter, contentColumnWidth.wide)
    : Math.min(width - 2 * space.gutter, contentColumnWidth.form);
  const padding = isWide ? space.lg : halfPadding;
  const gap = isWide ? space.lg : space.md;
  const geometry = {
    contentWidth,
    fontScale,
    gap,
    padding,
    minimumTextWidth: isWide ? 176 : undefined,
  };
  const pair = spaceColumnsFit({ columns: 2, ...geometry });
  const expanded = isExpanded && spaceColumnsFit({ columns: 3, ...geometry });
  return { isWide, pair, expanded };
};

const spaceName = (card: SpaceCard, locale: AppLocale) =>
  Option.getOrElse(card.name, () => familyTitle(card.family, locale));

const factsText = (facts: SpaceFacts, locale: AppLocale) => {
  switch (facts.kind) {
    case "catalog":
      return facts.text;
    case "office-seats":
      return m.booking_space_office_seats({ count: facts.maximum }, { locale });
    case "always-open":
      return m.booking_space_always_open({}, { locale });
  }
};

const unitText = (unit: SpaceUnit, locale: AppLocale) => {
  switch (unit.kind) {
    case "day":
      return m.booking_tier_price_per_day({}, { locale });
    case "hour":
      return m.booking_space_per_hour({}, { locale });
    case "length":
      return m.booking_space_per_length({ length: unit.label }, { locale });
  }
};

/** The unit in words, for assistive tech, which reads no "/". */
const unitWords = (unit: SpaceUnit, locale: AppLocale) => {
  switch (unit.kind) {
    case "day":
      return m.booking_price_unit_per_day({}, { locale });
    case "hour":
      return m.booking_price_unit_per_hour({}, { locale });
    case "length":
      return unit.label;
  }
};

/** The card read as one link: name, price with its unit, then the facts. */
const cardLabel = (card: SpaceCard, locale: AppLocale) =>
  [
    spaceName(card, locale),
    `${m.booking_family_from_price(
      { price: formatMoney(card.fromPrice, locale) },
      { locale }
    )} ${unitWords(card.unit, locale)}`,
    factsText(card.facts, locale),
  ].join(", ");

/**
 * The spaces to book as picture cards, office and meeting room side by side
 * when both are offered and fit, every other card full width. A card opens
 * its space's booking.
 */
export function SpaceCards({
  cards,
  locale,
  onOpen,
  afterCowork,
  teamTable,
}: {
  readonly cards: ReadonlyArray<SpaceCard>;
  readonly locale: AppLocale;
  readonly onOpen: (family: BookingFamily) => void;
  readonly afterCowork?: ReactNode;
  readonly teamTable?: AsyncResult.AsyncResult<
    CustomerTeamTableOfferings,
    unknown
  >;
}) {
  const { isWide, pair, expanded } = useSpaceGrid();
  const rows = spaceRows(cards, pair, expanded);
  return (
    <View style={[styles.cards, isWide && styles.wideGap]}>
      {rows.map((row) => (
        <SpaceCardRow
          key={row.map(({ family }) => family).join(":")}
          row={row}
          wide={isWide}
          locale={locale}
          onOpen={onOpen}
          afterCowork={afterCowork}
        />
      ))}
      {teamTable !== undefined && AsyncResult.isSuccess(teamTable) && (
        <TeamTableCard
          offerings={teamTable.value.offerings}
          locale={locale}
          onOpen={() => onOpen("table")}
        />
      )}
    </View>
  );
}

function TeamTableCard({
  offerings,
  locale,
  onOpen,
}: {
  readonly offerings: CustomerTeamTableOfferings["offerings"];
  readonly locale: AppLocale;
  readonly onOpen: () => void;
}) {
  const capacities = teamTableCapacities(offerings);
  const name = capacities[0]?.name;
  if (name === undefined) return null;
  const rates = capacities.map((offering) => ({
    seats: offering.product.seats,
    label: teamTableCapacityLabel(offering.product.seats, locale),
    rate: teamTableRateLabel(offering, locale),
  }));
  return (
    <Pressable
      role="link"
      accessibilityLabel={[
        name,
        ...rates.map(({ label, rate }) => `${label}, ${rate}`),
      ].join(", ")}
      onPress={onOpen}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <Image
        aria-hidden
        source={require("../../../assets/images/booking/open-space.webp")}
        resizeMode="cover"
        style={styles.teamTablePicture}
      />
      <View style={styles.teamTableText}>
        <Text tone="default" style={styles.fullTitle}>
          {name}
        </Text>
        {rates.map(({ seats, label, rate }) => (
          <View key={seats} style={styles.teamTableRate}>
            <Text variant="hint">{label}</Text>
            <Text variant="bodyStrong">{rate}</Text>
          </View>
        ))}
      </View>
    </Pressable>
  );
}

function SpaceCardRow({
  row,
  wide,
  locale,
  onOpen,
  afterCowork,
}: {
  readonly row: SpaceRow;
  readonly wide: boolean;
  readonly locale: AppLocale;
  readonly onOpen: (family: CustomerReservationFamily) => void;
  readonly afterCowork?: ReactNode;
}) {
  if (row.length === 1) {
    return (
      <>
        <FullCard card={row[0]} locale={locale} onOpen={onOpen} />
        {row[0].family === "cowork" && afterCowork}
      </>
    );
  }
  const pairStyle = [styles.pair, wide && styles.wideGap];
  return (
    <>
      <View style={pairStyle}>
        {row.map((card) => (
          <HalfCard
            key={card.family}
            card={card}
            wide={wide}
            locale={locale}
            onOpen={onOpen}
          />
        ))}
      </View>
      {afterCowork && row.some(({ family }) => family === "cowork") && (
        <View style={pairStyle}>
          {row.map(({ family }) => (
            <View key={family} style={styles.half}>
              {family === "cowork" && afterCowork}
            </View>
          ))}
        </View>
      )}
    </>
  );
}

function CardShell({
  card,
  locale,
  onOpen,
  half,
  wide = false,
  children,
}: {
  readonly card: SpaceCard;
  readonly locale: AppLocale;
  readonly onOpen: (family: CustomerReservationFamily) => void;
  readonly half: boolean;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Pressable
      // It opens the space's booking, as a list row that navigates does.
      role="link"
      accessibilityLabel={cardLabel(card, locale)}
      onPress={() => onOpen(card.family)}
      style={({ pressed }) => [
        styles.card,
        half && styles.half,
        pressed && styles.pressed,
      ]}
    >
      <SpaceIllustration
        family={card.family}
        height={half && !wide ? pictureHeight.half : pictureHeight.full}
        span={half ? "half" : "full"}
      />
      {children}
    </Pressable>
  );
}

function HalfCard({
  card,
  wide,
  locale,
  onOpen,
}: {
  readonly card: SpaceCard;
  readonly wide: boolean;
  readonly locale: AppLocale;
  readonly onOpen: (family: CustomerReservationFamily) => void;
}) {
  return (
    <CardShell card={card} locale={locale} onOpen={onOpen} half wide={wide}>
      <View style={[styles.halfText, wide && styles.wideText]}>
        <Text variant={wide ? "title" : "bodyStrong"}>
          {spaceName(card, locale)}
        </Text>
        <FromPrice card={card} locale={locale} size={wide ? "full" : "half"} />
        <Text variant="hint">{factsText(card.facts, locale)}</Text>
      </View>
    </CardShell>
  );
}

function FullCard({
  card,
  locale,
  onOpen,
}: {
  readonly card: SpaceCard;
  readonly locale: AppLocale;
  readonly onOpen: (family: CustomerReservationFamily) => void;
}) {
  return (
    <CardShell card={card} locale={locale} onOpen={onOpen} half={false}>
      <View style={styles.fullText}>
        <View style={styles.fullName}>
          <Text tone="default" style={styles.fullTitle}>
            {spaceName(card, locale)}
          </Text>
          <Text variant="hint">{factsText(card.facts, locale)}</Text>
        </View>
        <FromPrice card={card} locale={locale} size="full" />
      </View>
    </CardShell>
  );
}

/** The price with its unit on one line, a small "from" above. */
function FromPrice({
  card,
  locale,
  size,
}: {
  readonly card: SpaceCard;
  readonly locale: AppLocale;
  readonly size: "half" | "full";
}) {
  return (
    <View style={styles.price}>
      <Text variant="hint" style={styles.from}>
        {m.booking_space_from({}, { locale })}
      </Text>
      <View style={styles.amountLine}>
        <Text
          tone="default"
          numeric
          style={size === "half" ? styles.amountHalf : styles.amountFull}
        >
          {formatMoney(card.fromPrice, locale)}
        </Text>
        <Text
          variant="hint"
          style={size === "half" ? styles.unitHalf : styles.unitFull}
        >
          {unitText(card.unit, locale)}
        </Text>
      </View>
    </View>
  );
}

/**
 * The cards still loading, in their final layout: the office and meeting
 * room side by side, the cowork desk full width under them.
 */
export function SpaceCardsSkeleton({ label }: { readonly label: string }) {
  const { isWide, pair, expanded } = useSpaceGrid();
  return (
    <SkeletonGroup label={label}>
      <View style={[styles.cards, isWide && styles.wideGap]}>
        {pair ? (
          <View style={[styles.pair, isWide && styles.wideGap]}>
            <HalfSkeleton wide={isWide} />
            <HalfSkeleton wide={isWide} />
            {expanded && <HalfSkeleton wide={isWide} />}
          </View>
        ) : (
          <>
            <FullSkeleton />
            <FullSkeleton />
          </>
        )}
        {!expanded && <FullSkeleton />}
      </View>
    </SkeletonGroup>
  );
}

function HalfSkeleton({ wide }: { readonly wide: boolean }) {
  return (
    <View style={[styles.card, styles.half]}>
      <Skeleton
        width="100%"
        height={wide ? pictureHeight.full : pictureHeight.half}
        radius={0}
      />
      <View style={[styles.halfSkeletonText, wide && styles.wideText]}>
        <Skeleton width="70%" height={16} />
        <Skeleton width="55%" height={12} />
        <Skeleton width="80%" height={12} />
      </View>
    </View>
  );
}

function FullSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton width="100%" height={pictureHeight.full} radius={0} />
      <View style={styles.fullSkeletonText}>
        <Skeleton width="45%" height={18} />
        <Skeleton width="70%" height={12} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The board keeps the first card's top edge clear of the masthead's edge.
  cards: { gap: space.md, paddingTop: space.xs },
  pair: { alignItems: "stretch", flexDirection: "row", gap: space.md },
  wideGap: { gap: space.lg },
  card: {
    backgroundColor: color.surface,
    borderColor: color.line,
    borderRadius: radius.card,
    borderWidth: 1,
    overflow: "hidden",
    ...shadow.group,
  },
  half: { flex: 1, minWidth: 0 },
  pressed: { backgroundColor: color.pressed },
  halfText: {
    gap: space.xxs,
    paddingBottom: 14,
    paddingHorizontal: halfPadding,
    paddingTop: space.md,
  },
  wideText: { paddingHorizontal: space.lg },
  fullText: {
    alignItems: "center",
    columnGap: space.md,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    paddingBottom: 14,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    rowGap: space.xs,
  },
  // The name keeps at least 40% of the row; a price that no longer fits
  // beside it, with long names or large text, moves under it.
  fullName: { flexGrow: 1, flexShrink: 1, gap: space.xxs, minWidth: "40%" },
  teamTablePicture: { height: pictureHeight.full, width: "100%" },
  teamTableText: { gap: space.xs, padding: space.lg },
  teamTableRate: {
    alignItems: "baseline",
    columnGap: space.md,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  // Off the type scale, as the board sizes it: between headline and title.
  fullTitle: brandText(18, 24, 600),
  price: { alignItems: "flex-start" },
  from: { fontSize: 10, lineHeight: 11, marginBottom: -2 },
  amountLine: {
    alignItems: "baseline",
    columnGap: 3,
    flexDirection: "row",
    flexWrap: "wrap",
  },
  amountHalf: brandText(16, 22, 700),
  amountFull: brandText(18, 22, 700),
  unitHalf: { fontSize: 11, lineHeight: 16 },
  unitFull: { fontSize: 12, lineHeight: 16 },
  halfSkeletonText: { gap: 10, padding: space.md },
  fullSkeletonText: {
    gap: 10,
    paddingBottom: space.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
});
