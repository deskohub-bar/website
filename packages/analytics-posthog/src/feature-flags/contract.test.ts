import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  decodePostHogFeatureFlagPayload,
  decodePostHogFeatureFlagValue,
  definePostHogFeatureFlags,
} from "./contract";

const contract = definePostHogFeatureFlags<{
  readonly meeting_room_page: {
    readonly payload: undefined;
    readonly value: boolean;
  };
  readonly room_experience: {
    readonly payload: { readonly capacity: number } | undefined;
    readonly value: false | "control" | "treatment";
  };
}>({
  meeting_room_page: { payload: Schema.Undefined, value: Schema.Boolean },
  room_experience: {
    payload: Schema.Union([
      Schema.Undefined,
      Schema.Struct({ capacity: Schema.Number }),
    ]),
    value: Schema.Literals([false, "control", "treatment"]),
  },
});

describe("definePostHogFeatureFlags", () => {
  test("lists the keys of its decoders", () => {
    expect(contract.keys).toEqual(["meeting_room_page", "room_experience"]);
  });
});

describe("decodePostHogFeatureFlagValue", () => {
  test("returns a value the contract declares for the key", () => {
    expect(
      decodePostHogFeatureFlagValue(contract, "room_experience")("treatment")
    ).toBe("treatment");
    expect(
      decodePostHogFeatureFlagValue(contract, "meeting_room_page")(false)
    ).toBeFalse();
  });

  test("returns undefined for a value the contract does not declare", () => {
    expect(
      decodePostHogFeatureFlagValue(contract, "room_experience")("retired")
    ).toBeUndefined();
    expect(
      decodePostHogFeatureFlagValue(contract, "meeting_room_page")("control")
    ).toBeUndefined();
    expect(
      decodePostHogFeatureFlagValue(contract, "meeting_room_page")(undefined)
    ).toBeUndefined();
  });
});

describe("decodePostHogFeatureFlagPayload", () => {
  test("returns a payload of the declared shape", () => {
    expect(
      decodePostHogFeatureFlagPayload(
        contract,
        "room_experience"
      )({
        capacity: 8,
      })
    ).toEqual({ capacity: 8 });
  });

  test("returns undefined for a payload of another shape", () => {
    expect(
      decodePostHogFeatureFlagPayload(
        contract,
        "room_experience"
      )({
        capacity: "8",
      })
    ).toBeUndefined();
    expect(
      decodePostHogFeatureFlagPayload(
        contract,
        "meeting_room_page"
      )({
        capacity: 8,
      })
    ).toBeUndefined();
  });
});
