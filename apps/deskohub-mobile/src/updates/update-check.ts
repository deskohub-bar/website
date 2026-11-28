import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { AppStateSource } from "../platform/app-foreground";
import { checkNativeRelease, type NativeReleaseCheck } from "./native-release";
import {
  findReadyUpdate,
  type OtaUpdateSource,
  type ReadyUpdate,
} from "./ota-update";
import { installedByUpdater } from "./updater-install";

/**
 * The app checks when it returns to the foreground at most once per interval
 * since launch or its last check, so switching apps back and forth doesn't
 * poll the server.
 */
const updateCheckIntervalMs = 15 * 60 * 1000;

export const isUpdateCheckDue = (
  lastCheckStartedAt: number,
  now: number
): boolean =>
  now < lastCheckStartedAt || now - lastCheckStartedAt >= updateCheckIntervalMs;

export type UpdateCheckPlan = {
  readonly otaUpdate: boolean;
  readonly nativeRelease: boolean;
};

/**
 * Which checks apply. Web is served fresh by the Workspace. Only Android
 * installs APKs, so iOS checks only for JS updates, and an Android app that
 * an app store or updater installed leaves new APKs to it.
 * `otaUpdatesEnabled` is `Updates.isEnabled`, false when the build disables
 * or misconfigures expo-updates. `installingPackageName` is the installer
 * Android records for the app.
 */
export const planUpdateCheck = ({
  platform,
  otaUpdatesEnabled,
  installingPackageName,
}: {
  readonly platform: string;
  readonly otaUpdatesEnabled: boolean;
  readonly installingPackageName: string | null;
}): UpdateCheckPlan => ({
  otaUpdate: platform !== "web" && otaUpdatesEnabled,
  nativeRelease:
    platform === "android" && !installedByUpdater(installingPackageName),
});

/**
 * Runs the planned checks side by side and reports each result as soon as it
 * arrives, so a slow update download doesn't hold back a native offer.
 * Neither check can fail the other.
 */
export const runUpdateCheck = ({
  plan,
  updates,
  installedBuildVersion,
  latestReleaseUrl,
  onReadyUpdate,
  onNativeRelease,
}: {
  readonly plan: UpdateCheckPlan;
  readonly updates: OtaUpdateSource;
  readonly installedBuildVersion: string | null;
  readonly latestReleaseUrl: string;
  readonly onReadyUpdate: (update: ReadyUpdate | undefined) => void;
  readonly onNativeRelease: (check: NativeReleaseCheck) => void;
}): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.all(
    [
      plan.otaUpdate
        ? findReadyUpdate(updates).pipe(
            Effect.tap((update) => Effect.sync(() => onReadyUpdate(update)))
          )
        : Effect.void,
      plan.nativeRelease
        ? checkNativeRelease({ installedBuildVersion, latestReleaseUrl }).pipe(
            Effect.tap((check) => Effect.sync(() => onNativeRelease(check)))
          )
        : Effect.void,
    ],
    { concurrency: "unbounded", discard: true }
  );

/**
 * Runs the update checks one app session needs and returns the function that
 * stops them. Before launch, expo-updates already checked for a JS update or
 * rollback and started on it (`checkAutomatically: "ON_LOAD"` in
 * app.config.ts), so launch checks only for a newer APK, which expo-updates
 * can't install. Each return to the foreground once the interval has passed
 * runs every planned check, offering a JS update published while the app ran.
 */
export const scheduleUpdateChecks = ({
  plan,
  appState,
  now,
  check,
}: {
  readonly plan: UpdateCheckPlan;
  readonly appState: AppStateSource;
  readonly now: () => number;
  readonly check: (plan: UpdateCheckPlan) => void;
}): (() => void) => {
  let lastCheckStartedAt = now();
  if (plan.nativeRelease) {
    check({ otaUpdate: false, nativeRelease: true });
  }
  const subscription = appState.addEventListener("change", (state) => {
    const startedAt = now();
    if (
      state !== "active" ||
      !isUpdateCheckDue(lastCheckStartedAt, startedAt)
    ) {
      return;
    }
    lastCheckStartedAt = startedAt;
    check(plan);
  });
  return () => subscription.remove();
};
