import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  type AudienceAttribute,
  audienceAttributeCatalogue,
} from "@deskohub/workspace-admin-api";
import { Schema } from "effect";
import {
  type AudienceFilter,
  audienceFilterSchema,
} from "../../audience-filter";
import { isSavedAudienceAttribute } from "../../audience-filter-usage";
import type { DatePeriod } from "../../date-period";
import { audienceAttributeMenu } from "./audience-attribute-menu";
import {
  type AudienceFilterGroup,
  appendFilter,
  asRootGroup,
  type DatePeriodKind,
  editedCountCondition,
  editedDateCondition,
  newCondition,
  newConditionFrom,
  newNestedGroup,
  removeFilterAt,
  replaceFilterAt,
  switchDatePeriod,
  toggleSetValue,
} from "./audience-filter-editing";

const decodeFilter = Schema.decodeUnknownSync(audienceFilterSchema);

const attributes = Object.values(audienceAttributeCatalogue).map(
  ({ attribute }) => attribute
);

const emptyRoot: AudienceFilterGroup = {
  _tag: "Group",
  operator: "and",
  filters: [],
};

const tagged = (tag: string): AudienceFilter => ({
  attribute: "dotyposTags",
  _tag: "Condition",
  operator: "anyOf",
  value: [tag],
});

describe("asRootGroup", () => {
  test("keeps a stored group", () => {
    expect(asRootGroup(emptyRoot)).toBe(emptyRoot);
  });

  test("wraps a bare condition in an AND group", () => {
    const condition = newCondition("hasAccount");
    expect(asRootGroup(condition)).toEqual({
      _tag: "Group",
      operator: "and",
      filters: [condition],
    });
  });
});

describe("nested groups", () => {
  test("a nested group flips its parent's operator", () => {
    expect(newNestedGroup(emptyRoot).operator).toBe("or");
    expect(newNestedGroup({ ...emptyRoot, operator: "or" }).operator).toBe(
      "and"
    );
  });

  test("adds, edits and removes conditions inside a nested group", () => {
    const withGroup = appendFilter(
      appendFilter(emptyRoot, newCondition("locale")),
      newNestedGroup(emptyRoot)
    );
    const nested = withGroup.filters[1];
    assert(nested?._tag === "Group");
    const filledNested = appendFilter(
      appendFilter(nested, tagged("coworker")),
      tagged("rpg")
    );
    const root = replaceFilterAt(withGroup, 1, filledNested);

    expect(root.filters[1]).toEqual({
      _tag: "Group",
      operator: "or",
      filters: [tagged("coworker"), tagged("rpg")],
    });

    const trimmed = replaceFilterAt(root, 1, removeFilterAt(filledNested, 0));
    const trimmedNested = trimmed.filters[1];
    assert(trimmedNested?._tag === "Group");
    expect(trimmedNested.filters).toEqual([tagged("rpg")]);
    expect(removeFilterAt(trimmed, 1).filters).toEqual([
      newCondition("locale"),
    ]);
  });

  test("edits never mutate the previous tree", () => {
    const before = appendFilter(emptyRoot, newCondition("hasAccount"));
    const snapshot = structuredClone(before);
    replaceFilterAt(before, 0, tagged("vip"));
    removeFilterAt(before, 0);
    appendFilter(before, newNestedGroup(before));
    expect(before).toEqual(snapshot);
  });
});

describe("toggleSetValue", () => {
  test("adds and removes a value, keeping the order", () => {
    expect(toggleSetValue(["a", "b"], "c", true)).toEqual(["a", "b", "c"]);
    expect(toggleSetValue(["a", "b"], "a", false)).toEqual(["b"]);
    expect(toggleSetValue(["a"], "a", true)).toEqual(["a"]);
  });
});

describe("switchDatePeriod", () => {
  const today = "2026-10-15";
  const range: DatePeriod = {
    _tag: "Range",
    from: "2026-01-01",
    to: "2026-02-01",
  };

  test.each<[DatePeriodKind, DatePeriod]>([
    ["AnyTime", { _tag: "AnyTime" }],
    ["Last", { _tag: "Last", count: 30, unit: "day" }],
    ["Range", range],
    ["Since", { _tag: "Since", date: "2026-01-01" }],
    ["Onward", { _tag: "Onward", date: "2026-01-01" }],
    ["Until", { _tag: "Until", date: "2026-02-01" }],
  ])(
    "keeps the dates it can when switching a range to %s",
    (kind, expected) => {
      expect(switchDatePeriod(range, kind, today)).toEqual(expected);
    }
  );

  test("starts dated periods on today when there were no dates", () => {
    expect(switchDatePeriod({ _tag: "AnyTime" }, "Range", today)).toEqual({
      _tag: "Range",
      from: today,
      to: today,
    });
  });

  test("switches stored periods the builder doesn't offer yet", () => {
    const triggerWindow: DatePeriod = {
      _tag: "TriggerWindow",
      side: "after",
      count: 2,
      unit: "week",
    };
    expect(switchDatePeriod({ _tag: "Past" }, "Since", today)).toEqual({
      _tag: "Since",
      date: today,
    });
    expect(switchDatePeriod(triggerWindow, "Until", today)).toEqual({
      _tag: "Until",
      date: today,
    });
    expect(switchDatePeriod(range, "Past", today)).toEqual({ _tag: "Past" });
    expect(switchDatePeriod(range, "TriggerWindow", today)).toEqual({
      _tag: "TriggerWindow",
      side: "before",
      count: 1,
      unit: "month",
    });
    expect(switchDatePeriod(triggerWindow, "TriggerWindow", today)).toBe(
      triggerWindow
    );
  });
});

describe("the attribute catalogue in the builder", () => {
  test("every attribute has a label, a menu section, and a valid or placeholder default", () => {
    const listed = audienceAttributeMenu("saved-audience").flatMap(
      ({ attributes: sectionAttributes }) => sectionAttributes
    );
    expect(listed.toSorted()).toEqual(
      attributes.filter(isSavedAudienceAttribute).toSorted()
    );
    // Saved audiences hold the first visit, so the menu offers it.
    expect(listed).toContain("firstVisit");
    for (const attribute of attributes) {
      expect(audienceAttributeCatalogue[attribute].label).not.toBe("");
      expect(newCondition(attribute).attribute).toBe(attribute);
    }
  });

  test("defaults decode, except set placeholders the operator must fill", () => {
    const placeholders = new Set<AudienceAttribute>([
      "dotyposTags",
      "discountGroup",
    ]);
    for (const attribute of attributes) {
      const decode = () => decodeFilter(newCondition(attribute));
      if (placeholders.has(attribute)) expect(decode).toThrow();
      else expect(decode()).toEqual(newCondition(attribute));
    }
  });
});

describe("newCondition", () => {
  test("starts every attribute from its own entry's defaults", () => {
    for (const attribute of attributes) {
      expect(newCondition(attribute)).toEqual(
        newConditionFrom(audienceAttributeCatalogue[attribute])
      );
    }
  });

  test("keeps the empty placeholder values the operator fills", () => {
    expect(newCondition("dotyposTags")).toMatchObject({ value: [] });
    expect(newCondition("discountGroup")).toMatchObject({ value: [] });
  });
});

describe("editedCountCondition", () => {
  const reservations = newConditionFrom(
    audienceAttributeCatalogue.reservationCount
  );
  const emails = newConditionFrom(
    audienceAttributeCatalogue.campaignEmailCount
  );

  test("keeps an edit of the attribute's own params, in the order emitted", () => {
    const edited = {
      ...reservations,
      params: { ...reservations.params, status: "complete", stay: "day" },
    };
    const kept = editedCountCondition("reservationCount", edited);
    expect(kept).toEqual(edited);
    expect(Object.keys(kept ?? {})).toEqual(Object.keys(edited));
  });

  test("keeps an unfinished comparison the form reports later", () => {
    const edited = { ...reservations, operator: "lt" as const, value: -1 };
    expect(editedCountCondition("reservationCount", edited)).toEqual(edited);
  });

  test("refuses another attribute's condition", () => {
    expect(editedCountCondition("reservationCount", emails)).toBeUndefined();
  });

  test("refuses a choice the attribute doesn't offer", () => {
    expect(
      editedCountCondition("reservationCount", {
        ...reservations,
        params: { ...reservations.params, dateBasis: "purchase" },
      })
    ).toBeUndefined();
    expect(
      editedCountCondition("campaignEmailCount", {
        ...emails,
        params: { ...emails.params, purpose: "visit" },
      })
    ).toBeUndefined();
  });

  test("refuses a product filter on an attribute without one", () => {
    expect(
      editedCountCondition("campaignEmailCount", {
        ...emails,
        params: {
          ...emails.params,
          product: { family: "cowork", properties: [] },
        },
      })
    ).toBeUndefined();
  });
});

describe("editedDateCondition", () => {
  const lastVisit = newConditionFrom(audienceAttributeCatalogue.lastVisit);
  const accountCreated = newConditionFrom(
    audienceAttributeCatalogue.accountCreated
  );
  const product = { family: "cowork" as const, properties: [] };

  test("keeps an edit of the attribute's own condition", () => {
    const edited = { ...lastVisit, params: { product } };
    expect(editedDateCondition("lastVisit", edited)).toEqual(edited);
  });

  test("refuses another attribute's condition", () => {
    expect(editedDateCondition("lastVisit", accountCreated)).toBeUndefined();
  });

  test("refuses a product filter on an attribute without one", () => {
    expect(
      editedDateCondition("accountCreated", {
        ...accountCreated,
        params: { product },
      })
    ).toBeUndefined();
  });
});
