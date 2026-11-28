import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { fakeAppState } from "../platform/testing/fake-app-state";
import type { OtaUpdateSource, ReadyUpdate } from "./ota-update";
import {
  isUpdateCheckDue,
  planUpdateCheck,
  runUpdateCheck,
  scheduleUpdateChecks,
  type UpdateCheckPlan,
} from "./update-check";
import { noUpdatePromptDismissals, selectUpdatePrompt } from "./update-prompt";

describe("isUpdateCheckDue", () => {
  const startedAt = 1_000_000;
  const fifteenMinutesMs = 15 * 60 * 1000;

  test("waits fifteen minutes between checks", () => {
    expect(isUpdateCheckDue(startedAt, startedAt)).toBeFalse();
    expect(
      isUpdateCheckDue(startedAt, startedAt + fifteenMinutesMs - 1)
    ).toBeFalse();
    expect(
      isUpdateCheckDue(startedAt, startedAt + fifteenMinutesMs)
    ).toBeTrue();
  });

  test("checks again when the clock moved back behind the last check", () => {
    expect(isUpdateCheckDue(startedAt, startedAt - 1)).toBeTrue();
  });
});

// What the system package installer records for an APK a browser downloaded.
const sideloaded = "com.google.android.packageinstaller";

describe("planUpdateCheck", () => {
  test("checks both kinds of update on Android", () => {
    expect(
      planUpdateCheck({
        platform: "android",
        otaUpdatesEnabled: true,
        installingPackageName: sideloaded,
      })
    ).toEqual({ otaUpdate: true, nativeRelease: true });
  });

  test("checks only over-the-air updates on iOS, where no APK applies", () => {
    expect(
      planUpdateCheck({
        platform: "ios",
        otaUpdatesEnabled: true,
        installingPackageName: sideloaded,
      })
    ).toEqual({ otaUpdate: true, nativeRelease: false });
  });

  test("skips over-the-air updates when expo-updates is disabled", () => {
    expect(
      planUpdateCheck({
        platform: "android",
        otaUpdatesEnabled: false,
        installingPackageName: sideloaded,
      })
    ).toEqual({ otaUpdate: false, nativeRelease: true });
  });

  test.each([
    "dev.imranr.obtainium",
    "dev.imranr.obtainium.fdroid",
    "org.fdroid.fdroid",
    "com.looker.droidify",
    "com.android.vending",
  ])("leaves new APKs to %s, which installed the app", (installer) => {
    expect(
      planUpdateCheck({
        platform: "android",
        otaUpdatesEnabled: true,
        installingPackageName: installer,
      })
    ).toEqual({ otaUpdate: true, nativeRelease: false });
  });

  test.each([
    ["the system package installer", sideloaded],
    ["a browser that installed it directly", "com.android.chrome"],
    ["no recorded installer, as after adb install", null],
    ["the shell, as an Obtainium install through Shizuku", "com.android.shell"],
  ])("offers new APKs when %s installed the app", (_installer, installer) => {
    expect(
      planUpdateCheck({
        platform: "android",
        otaUpdatesEnabled: true,
        installingPackageName: installer,
      })
    ).toEqual({ otaUpdate: true, nativeRelease: true });
  });

  test("checks nothing on web, which the Workspace serves fresh", () => {
    expect(
      planUpdateCheck({
        platform: "web",
        otaUpdatesEnabled: true,
        installingPackageName: sideloaded,
      })
    ).toEqual({ otaUpdate: false, nativeRelease: false });
  });
});

const checkResult = {
  isAvailable: true,
  isRollBackToEmbedded: false,
  manifest: { id: "update-a" },
  reason: undefined,
} as unknown as Awaited<ReturnType<OtaUpdateSource["checkForUpdateAsync"]>>;
const fetchResult = {
  isNew: true,
  isRollBackToEmbedded: false,
  manifest: { id: "update-a" },
} as unknown as Awaited<ReturnType<OtaUpdateSource["fetchUpdateAsync"]>>;

const rollBackCheckResult = {
  isAvailable: false,
  isRollBackToEmbedded: true,
  manifest: undefined,
  reason: undefined,
} as unknown as typeof checkResult;
const rollBackFetchResult = {
  isNew: false,
  isRollBackToEmbedded: true,
  manifest: undefined,
} as unknown as typeof fetchResult;

const recordingSources = ({
  answer = async () => checkResult,
  download = async () => fetchResult,
}: {
  readonly answer?: () => Promise<typeof checkResult>;
  readonly download?: () => Promise<typeof fetchResult>;
} = {}) => {
  const calls: Array<string> = [];
  const updates: OtaUpdateSource = {
    checkForUpdateAsync: () => {
      calls.push("ota-check");
      return answer();
    },
    fetchUpdateAsync: () => {
      calls.push("ota-fetch");
      return download();
    },
  };
  const fetch = Object.assign(
    async () => {
      calls.push("release-lookup");
      return Response.json({ versionName: "1.3.0", versionCode: 1_003_000 });
    },
    { preconnect: globalThis.fetch.preconnect }
  );
  const layer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))
  );
  return { calls, layer, updates };
};

const check = (
  platform: string,
  sources: ReturnType<typeof recordingSources>,
  reports: Array<unknown>
) =>
  runUpdateCheck({
    plan: planUpdateCheck({
      platform,
      otaUpdatesEnabled: true,
      installingPackageName: sideloaded,
    }),
    updates: sources.updates,
    installedBuildVersion: "1002000",
    latestReleaseUrl: "https://workspace.test/api/mobile/releases/latest",
    onReadyUpdate: (update) => reports.push({ readyUpdate: update }),
    onNativeRelease: (release) => reports.push({ nativeRelease: release }),
  }).pipe(Effect.provide(sources.layer));

describe("runUpdateCheck", () => {
  test("reports both updates on Android", async () => {
    const sources = recordingSources();
    const reports: Array<unknown> = [];
    await Effect.runPromise(check("android", sources, reports));
    expect(reports).toContainEqual({
      readyUpdate: { kind: "update", updateId: "update-a" },
    });
    expect(reports).toContainEqual({
      nativeRelease: {
        kind: "newer",
        offer: { versionName: "1.3.0", versionCode: 1_003_000 },
      },
    });
    expect(sources.calls.toSorted()).toEqual([
      "ota-check",
      "ota-fetch",
      "release-lookup",
    ]);
  });

  test("reports the embedded update ready after a rollback directive", async () => {
    const sources = recordingSources({
      answer: async () => rollBackCheckResult,
      download: async () => rollBackFetchResult,
    });
    const reports: Array<unknown> = [];
    await Effect.runPromise(check("ios", sources, reports));
    expect(reports).toEqual([{ readyUpdate: { kind: "embedded" } }]);
    expect(sources.calls).toEqual(["ota-check", "ota-fetch"]);
  });

  test("reports the native release while an update is still downloading", async () => {
    const sources = recordingSources({
      download: () => new Promise(() => undefined),
    });
    const reports: Array<unknown> = [];
    const fiber = Effect.runFork(check("android", sources, reports));
    await Effect.runPromise(
      Effect.sleep("1 millis").pipe(
        Effect.repeat({ until: () => reports.length > 0 }),
        Effect.timeout("2 seconds")
      )
    );
    expect(reports).toEqual([
      {
        nativeRelease: {
          kind: "newer",
          offer: { versionName: "1.3.0", versionCode: 1_003_000 },
        },
      },
    ]);
    await Effect.runPromise(Fiber.interrupt(fiber));
  });

  test("asks nothing of either source on web", async () => {
    const sources = recordingSources();
    const reports: Array<unknown> = [];
    await Effect.runPromise(check("web", sources, reports));
    expect(reports).toEqual([]);
    expect(sources.calls).toEqual([]);
  });
});

describe("scheduleUpdateChecks", () => {
  const launchedAt = 1_000_000;
  const fifteenMinutesMs = 15 * 60 * 1000;
  const androidPlan: UpdateCheckPlan = { otaUpdate: true, nativeRelease: true };

  const session = (plan: UpdateCheckPlan) => {
    const appState = fakeAppState("active");
    const clock = { now: launchedAt };
    const checks: Array<UpdateCheckPlan> = [];
    const stop = scheduleUpdateChecks({
      plan,
      appState: appState.source,
      now: () => clock.now,
      check: (planned) => checks.push(planned),
    });
    const returnAt = (at: number) => {
      clock.now = at;
      appState.change("background");
      appState.change("active");
    };
    return { appState, checks, returnAt, stop };
  };

  test("checks only for a newer APK on launch, which started on the newest JS update", () => {
    expect(session(androidPlan).checks).toEqual([
      { otaUpdate: false, nativeRelease: true },
    ]);
    expect(session({ otaUpdate: true, nativeRelease: false }).checks).toEqual(
      []
    );
  });

  test("waits fifteen minutes after launch before checking again", () => {
    const { checks, returnAt } = session(androidPlan);
    returnAt(launchedAt + 1000);
    returnAt(launchedAt + fifteenMinutesMs - 1);
    expect(checks).toEqual([{ otaUpdate: false, nativeRelease: true }]);
  });

  test("checks for every planned update on a return fifteen minutes on", () => {
    const { checks, returnAt } = session(androidPlan);
    returnAt(launchedAt + fifteenMinutesMs);
    returnAt(launchedAt + fifteenMinutesMs + 1000);
    returnAt(launchedAt + 2 * fifteenMinutesMs);
    expect(checks).toEqual([
      { otaUpdate: false, nativeRelease: true },
      androidPlan,
      androidPlan,
    ]);
  });

  test("checks nothing at launch on iOS and waits as long before the JS check", () => {
    const iosPlan = { otaUpdate: true, nativeRelease: false };
    const { checks, returnAt } = session(iosPlan);
    returnAt(launchedAt + fifteenMinutesMs - 1);
    expect(checks).toEqual([]);
    returnAt(launchedAt + fifteenMinutesMs);
    expect(checks).toEqual([iosPlan]);
  });

  test("checks only when the app becomes active", () => {
    const appState = fakeAppState("active");
    const clock = { now: launchedAt };
    const checks: Array<UpdateCheckPlan> = [];
    scheduleUpdateChecks({
      plan: androidPlan,
      appState: appState.source,
      now: () => clock.now,
      check: (planned) => checks.push(planned),
    });
    clock.now = launchedAt + fifteenMinutesMs;
    appState.change("inactive");
    appState.change("background");
    expect(checks).toEqual([{ otaUpdate: false, nativeRelease: true }]);
    appState.change("active");
    expect(checks).toEqual([
      { otaUpdate: false, nativeRelease: true },
      androidPlan,
    ]);
  });

  test("checks nothing once stopped", () => {
    const { appState, checks, returnAt, stop } = session(androidPlan);
    stop();
    expect(appState.listeners.size).toBe(0);
    returnAt(launchedAt + fifteenMinutesMs);
    expect(checks).toEqual([{ otaUpdate: false, nativeRelease: true }]);
  });

  const promptAfterReturn = async (
    sources: ReturnType<typeof recordingSources>,
    platform: string
  ) => {
    const appState = fakeAppState("active");
    const clock = { now: launchedAt };
    const runs: Array<Promise<void>> = [];
    let readyUpdate: ReadyUpdate | undefined;
    scheduleUpdateChecks({
      plan: planUpdateCheck({
        platform,
        otaUpdatesEnabled: true,
        installingPackageName: sideloaded,
      }),
      appState: appState.source,
      now: () => clock.now,
      check: (plan) =>
        runs.push(
          Effect.runPromise(
            runUpdateCheck({
              plan,
              updates: sources.updates,
              installedBuildVersion: "1003000",
              latestReleaseUrl:
                "https://workspace.test/api/mobile/releases/latest",
              onReadyUpdate: (update) => {
                readyUpdate = update ?? readyUpdate;
              },
              onNativeRelease: () => undefined,
            }).pipe(Effect.provide(sources.layer))
          )
        ),
    });
    await Promise.all(runs);
    const prompt = () =>
      selectUpdatePrompt({
        nativeUpdate: undefined,
        readyUpdate,
        runsEmbeddedUpdate: false,
        dismissals: noUpdatePromptDismissals,
      });
    const atLaunch = prompt();
    clock.now = launchedAt + fifteenMinutesMs;
    appState.change("background");
    appState.change("active");
    await Promise.all(runs);
    return { atLaunch, afterReturn: prompt() };
  };

  test("offers a JS update only from a check on a later return, not at launch", async () => {
    const sources = recordingSources();
    const { atLaunch, afterReturn } = await promptAfterReturn(
      sources,
      "android"
    );
    expect(atLaunch).toBeUndefined();
    expect(afterReturn).toEqual({ kind: "ota-update", updateId: "update-a" });
    expect(sources.calls.toSorted()).toEqual([
      "ota-check",
      "ota-fetch",
      "release-lookup",
      "release-lookup",
    ]);
  });

  test("offers a rollback only from a check on a later return, not at launch", async () => {
    const sources = recordingSources({
      answer: async () => rollBackCheckResult,
      download: async () => rollBackFetchResult,
    });
    const { atLaunch, afterReturn } = await promptAfterReturn(sources, "ios");
    expect(atLaunch).toBeUndefined();
    expect(afterReturn).toEqual({ kind: "roll-back" });
    expect(sources.calls).toEqual(["ota-check", "ota-fetch"]);
  });
});
