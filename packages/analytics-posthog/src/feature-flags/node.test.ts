import { describe, expect, mock, test } from "bun:test";
import { Effect, Schema } from "effect";
import type {
  AllFlagsOptions,
  OverrideFeatureFlagsOptions,
  PostHog,
  PostHogOptions,
} from "posthog-node";

type FlagsAndPayloads = Awaited<ReturnType<PostHog["getAllFlagsAndPayloads"]>>;

import { PostHogDistinctId } from "../identifiers";
import { definePostHogFeatureFlags } from "./contract";

const evaluateFlags = mock((_distinctId: string, _options?: AllFlagsOptions) =>
  Promise.resolve({
    getFlag: () => true,
    getFlagPayload: () => undefined,
    isEnabled: () => true,
  })
);
const getAllFlagsAndPayloads = mock(
  (
    _distinctId: string,
    _options?: AllFlagsOptions
  ): Promise<FlagsAndPayloads> =>
    Promise.resolve({
      featureFlags: {
        meeting_room_page: true,
        room_experience: "treatment",
      },
      featureFlagPayloads: {
        room_experience: { capacity: 8 },
      },
    })
);
const shutdown = mock(() => Promise.resolve());
const createClient = mock(
  (_projectToken: string, _options?: PostHogOptions) => {}
);
const overrideFeatureFlags = mock(
  (_overrides: OverrideFeatureFlagsOptions) => {}
);

mock.module("posthog-node", () => ({
  PostHog: function PostHog(projectToken: string, options?: PostHogOptions) {
    createClient(projectToken, options);

    return {
      evaluateFlags,
      getAllFlagsAndPayloads,
      overrideFeatureFlags,
      shutdown,
    };
  },
}));

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

const globalReleaseId = PostHogDistinctId.make("global-release");
const visitorId = PostHogDistinctId.make("visitor-id");
const anotherVisitorId = PostHogDistinctId.make("another-visitor-id");

describe("makePostHogNodeFeatureFlagService", () => {
  test("suppresses access events for a non-recording batched subject", async () => {
    const { makePostHogNodeFeatureFlagService } = await import("./node");
    createClient.mockClear();
    evaluateFlags.mockClear();
    getAllFlagsAndPayloads.mockClear();
    const featureFlags = makePostHogNodeFeatureFlagService(contract, {
      defaultEvaluationOptions: { disableGeoip: true },
      projectToken: "phc_test",
    });

    const snapshot = await Effect.runPromise(
      featureFlags.evaluateFlags({
        options: {
          flagKeys: ["meeting_room_page", "room_experience"],
        },
        subject: {
          distinctId: globalReleaseId,
          sendFeatureFlagEvents: false,
        },
      })
    );

    expect(snapshot.getFlag("meeting_room_page")).toBeTrue();
    expect(snapshot.getFlag("room_experience")).toBe("treatment");
    expect(snapshot.getFlagPayload("room_experience")).toEqual({ capacity: 8 });
    expect(snapshot.isEnabled("meeting_room_page")).toBeTrue();
    expect(getAllFlagsAndPayloads).toHaveBeenCalledTimes(1);
    expect(getAllFlagsAndPayloads).toHaveBeenCalledWith("global-release", {
      disableGeoip: true,
      flagKeys: ["meeting_room_page", "room_experience"],
    });
    expect(evaluateFlags).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledTimes(1);

    await Effect.runPromise(featureFlags.shutdown);
  });

  test("drops a value or payload the contract does not declare", async () => {
    const { makePostHogNodeFeatureFlagService } = await import("./node");
    getAllFlagsAndPayloads.mockImplementationOnce(() =>
      Promise.resolve({
        featureFlags: {
          meeting_room_page: "control",
          room_experience: "retired",
        },
        featureFlagPayloads: {
          room_experience: { capacity: "eight" },
        },
      })
    );
    const featureFlags = makePostHogNodeFeatureFlagService(contract, {
      projectToken: "phc_test",
    });

    const snapshot = await Effect.runPromise(
      featureFlags.evaluateFlags({
        subject: {
          distinctId: globalReleaseId,
          sendFeatureFlagEvents: false,
        },
      })
    );

    expect(snapshot.getFlag("meeting_room_page")).toBeUndefined();
    expect(snapshot.getFlag("room_experience")).toBeUndefined();
    expect(snapshot.getFlagPayload("room_experience")).toBeUndefined();

    await Effect.runPromise(featureFlags.shutdown);
  });

  test("retains access events for a recording batched subject", async () => {
    const { makePostHogNodeFeatureFlagService } = await import("./node");
    createClient.mockClear();
    evaluateFlags.mockClear();
    getAllFlagsAndPayloads.mockClear();
    const featureFlags = makePostHogNodeFeatureFlagService(contract, {
      defaultEvaluationOptions: { disableGeoip: true },
      projectToken: "phc_test",
    });

    await Effect.runPromise(
      featureFlags.evaluateFlags({
        options: { flagKeys: ["meeting_room_page"] },
        subject: {
          distinctId: visitorId,
          sendFeatureFlagEvents: true,
        },
      })
    );

    expect(evaluateFlags).toHaveBeenCalledTimes(1);
    expect(evaluateFlags).toHaveBeenCalledWith("visitor-id", {
      disableGeoip: true,
      flagKeys: ["meeting_room_page"],
    });
    expect(getAllFlagsAndPayloads).not.toHaveBeenCalled();
    expect(createClient).toHaveBeenCalledTimes(1);

    await Effect.runPromise(featureFlags.shutdown);
  });

  test("reuses one SDK client for the service lifetime", async () => {
    const { makePostHogNodeFeatureFlagService } = await import("./node");
    createClient.mockClear();
    evaluateFlags.mockClear();
    getAllFlagsAndPayloads.mockClear();
    shutdown.mockClear();
    overrideFeatureFlags.mockClear();
    const featureFlags = makePostHogNodeFeatureFlagService(contract, {
      defaultEvaluationOptions: { disableGeoip: true },
      projectToken: "phc_test",
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(overrideFeatureFlags).not.toHaveBeenCalled();

    await Effect.runPromise(
      featureFlags.evaluateFlags({
        options: { flagKeys: ["meeting_room_page"] },
        subject: {
          distinctId: visitorId,
          sendFeatureFlagEvents: true,
        },
      })
    );
    await Effect.runPromise(
      featureFlags.evaluateFlags({
        options: { flagKeys: ["meeting_room_page"] },
        subject: {
          distinctId: anotherVisitorId,
          sendFeatureFlagEvents: false,
        },
      })
    );

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(overrideFeatureFlags).not.toHaveBeenCalled();
    expect(evaluateFlags).toHaveBeenCalledWith("visitor-id", {
      disableGeoip: true,
      flagKeys: ["meeting_room_page"],
    });
    expect(getAllFlagsAndPayloads).toHaveBeenCalledWith("another-visitor-id", {
      disableGeoip: true,
      flagKeys: ["meeting_room_page"],
    });
    expect(shutdown).not.toHaveBeenCalled();

    await Effect.runPromise(featureFlags.shutdown);

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  test("applies fixed overrides once when the lazy SDK client is created", async () => {
    const { makePostHogNodeFeatureFlagService } = await import("./node");
    createClient.mockClear();
    evaluateFlags.mockClear();
    overrideFeatureFlags.mockClear();
    const featureFlags = makePostHogNodeFeatureFlagService(contract, {
      featureFlagOverrides: {
        meeting_room_page: false,
        room_experience: "treatment",
      },
      projectToken: "phc_test",
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(overrideFeatureFlags).not.toHaveBeenCalled();

    await Effect.runPromise(
      featureFlags.evaluateFlags({
        subject: {
          distinctId: visitorId,
          sendFeatureFlagEvents: true,
        },
      })
    );
    await Effect.runPromise(
      featureFlags.evaluateFlags({
        subject: {
          distinctId: globalReleaseId,
          sendFeatureFlagEvents: false,
        },
      })
    );
    await Effect.runPromise(
      featureFlags.evaluateFlags({
        subject: {
          distinctId: anotherVisitorId,
          sendFeatureFlagEvents: false,
        },
      })
    );

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(overrideFeatureFlags).toHaveBeenCalledTimes(1);
    expect(overrideFeatureFlags).toHaveBeenCalledWith({
      meeting_room_page: false,
      room_experience: "treatment",
    });

    await Effect.runPromise(featureFlags.shutdown);
  });

  test("reports missing runtime configuration through the Effect error channel", async () => {
    const {
      makePostHogNodeFeatureFlagService,
      PostHogFeatureFlagEvaluationError,
    } = await import("./node");
    createClient.mockClear();
    const featureFlags = makePostHogNodeFeatureFlagService(contract, {
      clientOptions: { host: "https://posthog.example" },
    });

    const error = await Effect.runPromise(
      featureFlags
        .evaluateFlags({
          subject: {
            distinctId: visitorId,
            sendFeatureFlagEvents: true,
          },
        })
        .pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(PostHogFeatureFlagEvaluationError);
    expect(createClient).not.toHaveBeenCalled();
  });
});
