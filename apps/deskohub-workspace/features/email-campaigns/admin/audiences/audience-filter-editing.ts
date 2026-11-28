import {
  type AudienceAttribute,
  type AudienceAttributeDefinition,
  type AudienceAttributeOfKind,
  type AudienceConditionOf,
  type AudienceCountCondition,
  type AudienceDateCondition,
  type AudienceFilterGroupOf,
  type AudienceFilterOf,
  audienceAttributeCatalogue,
  type DatePeriodUnitType,
  type InSavedAudienceType as InSavedAudience,
} from "@deskohub/workspace-admin-api";
import { Match, Schema } from "effect";
import type {
  AudienceCondition,
  AudienceFilterGroup,
} from "../../audience-filter";
import type { DatePeriod } from "../../date-period";

export type { AudienceCondition, AudienceFilterGroup };

/**
 * The audience a new saved-audience membership leaf holds until the operator
 * picks one. It is no valid audience ID, so the form reports it as missing.
 */
export const unchosenSavedAudience = "";

/** Saved-audience membership as the builder holds it, possibly with no audience picked yet. */
export type SavedAudienceMembershipDraft = {
  readonly _tag: InSavedAudience["_tag"];
  readonly operator: InSavedAudience["operator"];
  readonly audienceId:
    | InSavedAudience["audienceId"]
    | typeof unchosenSavedAudience;
};

/** A leaf the builder edits: a catalogue condition or saved-audience membership. */
export type AudienceFilterLeaf =
  | AudienceCondition
  | SavedAudienceMembershipDraft;

/** The builder always edits a group, so a bare stored condition gets an AND root. */
export const asRootGroup = <Leaf extends AudienceFilterLeaf>(
  filter: AudienceFilterOf<Leaf>
): AudienceFilterGroupOf<Leaf> =>
  filter._tag === "Group"
    ? filter
    : { _tag: "Group", operator: "and", filters: [filter] };

const lastThirtyDays: DatePeriod = { _tag: "Last", count: 30, unit: "day" };

const monthBeforeTrigger: DatePeriod = {
  _tag: "TriggerWindow",
  side: "before",
  count: 1,
  unit: "month",
};

/**
 * Whether a tree holds only catalogue conditions, so a saved audience can
 * keep it: no leaf is saved-audience membership.
 */
export const holdsOnlyConditions = (
  group: AudienceFilterGroupOf<AudienceFilterLeaf>
): group is AudienceFilterGroup =>
  group.filters.every((filter) =>
    filter._tag === "Group"
      ? holdsOnlyConditions(filter)
      : filter._tag === "Condition"
  );

/** A condition with the entry's defaults. */
export const newConditionFrom = <
  const Attribute extends AudienceAttributeDefinition["attribute"],
  Defaults extends AudienceAttributeDefinition["defaults"],
>({
  attribute,
  defaults,
}: {
  readonly attribute: Attribute;
  readonly defaults: Defaults;
}) => ({
  attribute,
  _tag: "Condition" as const,
  ...defaults,
});

const {
  reservationCount,
  firstVisit,
  lastVisit,
  campaignEmailCount,
  hasAccount,
  accountCreated,
  locale: localeAttribute,
  dotyposTags,
  discountGroup,
} = audienceAttributeCatalogue;

/** Each attribute's starting condition, typed against its own condition shape. */
const newConditions = {
  reservationCount: () => newConditionFrom(reservationCount),
  firstVisit: () => newConditionFrom(firstVisit),
  lastVisit: () => newConditionFrom(lastVisit),
  campaignEmailCount: () => newConditionFrom(campaignEmailCount),
  hasAccount: () => newConditionFrom(hasAccount),
  accountCreated: () => newConditionFrom(accountCreated),
  locale: () => newConditionFrom(localeAttribute),
  dotyposTags: () => newConditionFrom(dotyposTags),
  discountGroup: () => newConditionFrom(discountGroup),
} satisfies {
  readonly [Attribute in AudienceAttribute]: () => AudienceConditionOf<Attribute>;
};

/** Starting values for a condition an operator adds or switches to. */
export const newCondition = (attribute: AudienceAttribute): AudienceCondition =>
  newConditions[attribute]();

/**
 * The choice and campaign params each count attribute accepts. The period
 * and comparison stay as the controls emit them: an unfinished edit may fail
 * their refinements until the form reports it.
 */
const isReservationCountChoices = Schema.is(
  Schema.Struct({
    dateBasis: reservationCount.params.dateBasis.field,
    status: reservationCount.params.status.field,
    stay: reservationCount.params.stay.field,
    payment: reservationCount.params.payment.field,
  })
);

const isCampaignEmailCountChoices = Schema.is(
  Schema.Struct({
    purpose: campaignEmailCount.params.purpose.field,
    campaign: campaignEmailCount.params.campaign.field,
  })
);

type CountAttribute = AudienceAttributeOfKind<"count">;
type DateAttribute = AudienceAttributeOfKind<"date">;

const countConditions = {
  reservationCount: (edited) => {
    const { attribute, params } = edited;
    return attribute === "reservationCount" && isReservationCountChoices(params)
      ? { ...edited, attribute, params }
      : undefined;
  },
  campaignEmailCount: (edited) => {
    const { attribute, params } = edited;
    return attribute === "campaignEmailCount" &&
      params.product === undefined &&
      isCampaignEmailCountChoices(params)
      ? { ...edited, attribute, params }
      : undefined;
  },
} satisfies {
  readonly [Attribute in CountAttribute]: (
    edited: AudienceCountCondition
  ) => AudienceConditionOf<Attribute> | undefined;
};

/**
 * The catalogue condition of `attribute` that the shared count controls
 * emitted, or `undefined` when the edit isn't one: another attribute, a
 * choice the attribute doesn't offer, or a product filter on an attribute
 * without one.
 */
export const editedCountCondition = (
  attribute: CountAttribute,
  edited: AudienceCountCondition
): AudienceCondition | undefined => countConditions[attribute](edited);

const dateConditions = {
  firstVisit: (edited) =>
    edited.attribute === "firstVisit"
      ? { ...edited, attribute: edited.attribute }
      : undefined,
  lastVisit: (edited) =>
    edited.attribute === "lastVisit"
      ? { ...edited, attribute: edited.attribute }
      : undefined,
  accountCreated: (edited) =>
    edited.attribute === "accountCreated" && edited.params === undefined
      ? { ...edited, attribute: edited.attribute }
      : undefined,
} satisfies {
  readonly [Attribute in DateAttribute]: (
    edited: AudienceDateCondition
  ) => AudienceConditionOf<Attribute> | undefined;
};

/**
 * The catalogue condition of `attribute` that the shared date controls
 * emitted, or `undefined` when the edit isn't one: another attribute or a
 * product filter on an attribute without one.
 */
export const editedDateCondition = (
  attribute: DateAttribute,
  edited: AudienceDateCondition
): AudienceCondition | undefined => dateConditions[attribute](edited);

/** "Is in saved audience" with no audience picked yet. */
export const newSavedAudienceMembership = (): SavedAudienceMembershipDraft => ({
  _tag: "InAudience",
  operator: "in",
  audienceId: unchosenSavedAudience,
});

/** An empty group nested in `parent`, which usually flips the parent's logic. */
export const newNestedGroup = <Leaf extends AudienceFilterLeaf>(
  parent: AudienceFilterGroupOf<Leaf>
): AudienceFilterGroupOf<Leaf> => ({
  _tag: "Group",
  operator: parent.operator === "and" ? "or" : "and",
  filters: [],
});

export const appendFilter = <Leaf extends AudienceFilterLeaf>(
  group: AudienceFilterGroupOf<Leaf>,
  filter: AudienceFilterOf<Leaf>
): AudienceFilterGroupOf<Leaf> => ({
  ...group,
  filters: [...group.filters, filter],
});

export const replaceFilterAt = <Leaf extends AudienceFilterLeaf>(
  group: AudienceFilterGroupOf<Leaf>,
  index: number,
  filter: AudienceFilterOf<Leaf>
): AudienceFilterGroupOf<Leaf> => ({
  ...group,
  filters: group.filters.map((current, i) => (i === index ? filter : current)),
});

export const removeFilterAt = <Leaf extends AudienceFilterLeaf>(
  group: AudienceFilterGroupOf<Leaf>,
  index: number
): AudienceFilterGroupOf<Leaf> => ({
  ...group,
  filters: group.filters.filter((_, i) => i !== index),
});

/** Adds or removes one chosen value, keeping the original order. */
export const toggleSetValue = <Value>(
  selected: readonly Value[],
  value: Value,
  checked: boolean
): readonly Value[] => {
  const others = selected.filter((current) => current !== value);
  return checked ? [...others, value] : others;
};

export type DatePeriodKind = DatePeriod["_tag"];

/**
 * The period after the operator switches its kind, keeping the dates and
 * count it already had where the new kind uses them.
 */
export const switchDatePeriod = (
  period: DatePeriod,
  kind: DatePeriodKind,
  today: string
): DatePeriod => {
  const dates = Match.value(period).pipe(
    Match.tagsExhaustive({
      AnyTime: () => ({ from: today, to: today }),
      Past: () => ({ from: today, to: today }),
      Last: () => ({ from: today, to: today }),
      Range: ({ from, to }) => ({ from, to }),
      Since: ({ date }) => ({ from: date, to: date }),
      Onward: ({ date }) => ({ from: date, to: date }),
      Until: ({ date }) => ({ from: date, to: date }),
      TriggerWindow: () => ({ from: today, to: today }),
    })
  );
  return Match.value(kind).pipe(
    Match.when("AnyTime", (): DatePeriod => ({ _tag: "AnyTime" })),
    Match.when("Past", (): DatePeriod => ({ _tag: "Past" })),
    Match.when(
      "Last",
      (): DatePeriod => (period._tag === "Last" ? period : lastThirtyDays)
    ),
    Match.when(
      "Range",
      (): DatePeriod => ({ _tag: "Range", from: dates.from, to: dates.to })
    ),
    Match.when(
      "Since",
      (): DatePeriod => ({ _tag: "Since", date: dates.from })
    ),
    Match.when(
      "Onward",
      (): DatePeriod => ({ _tag: "Onward", date: dates.from })
    ),
    Match.when("Until", (): DatePeriod => ({ _tag: "Until", date: dates.to })),
    Match.when(
      "TriggerWindow",
      (): DatePeriod =>
        period._tag === "TriggerWindow" ? period : monthBeforeTrigger
    ),
    Match.exhaustive
  );
};

export const isDatePeriodUnit = (value: string): value is DatePeriodUnitType =>
  value === "day" || value === "week" || value === "month" || value === "year";
