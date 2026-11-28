import { Effect, Match, Option } from "effect";
import type { AuthSessionState } from "../auth/auth-session-state";
import {
  AccountExitFence,
  type AccountSession,
  clearDeviceOnboardingDraft,
  isAccountStorageKey,
  isExitClearedKey,
} from "./account-scoped-storage";
import {
  DeviceOnboardingDraft,
  DeviceStorage,
  TemporaryFiles,
} from "./device-capabilities";

/**
 * What an exit cleans up: one session's account data, on a launch that
 * finds no session whatever earlier accounts left, or on a launch that
 * restores one only the shared files earlier runs left.
 */
export type AccountExit =
  | ({ readonly scope: "account" } & AccountSession)
  | { readonly scope: "onboarding-session"; readonly sessionId: string }
  | { readonly scope: "device" }
  | { readonly scope: "shared-files" };

/**
 * Removes what an exiting account left on the device: its storage entries
 * and the temporary files it shared. It runs alone through the fence: an
 * account write in flight lands first, the exited session can't write
 * afterwards, and no entry is removed for an account that has signed in
 * again meanwhile or (device scope) that has a session open. Files a share
 * still holds stay until it ends; the sweep then runs with its release. A
 * storage failure leaves the keys for a later exit or launch; their names
 * carry the account, so no other account reads them.
 */
export const customerDataExitCleanup = (exit: AccountExit) =>
  Match.value(exit).pipe(
    Match.discriminatorsExhaustive("scope")({
      account: accountExitCleanup,
      "onboarding-session": ({ sessionId }) =>
        discardDraft((owner) => Effect.succeed(owner.sessionId === sessionId)),
      device: () => deviceExitCleanup,
      "shared-files": () => sweepUnheldFiles(Option.none()),
    }),
    (cleanup) =>
      Effect.flatMap(Effect.service(AccountExitFence), (fence) =>
        fence.exclusive(cleanup)
      ),
    Effect.uninterruptible,
    Effect.withSpan("CustomerData.exitCleanup")
  );

/** Explicit sign-out erases the native draft and pauses its writes until the cookie operation settles. */
export const eraseDraftForSignOut = <A, E, R>(
  sessionId: string | undefined,
  signOut: Effect.Effect<A, E, R>
) =>
  Effect.flatMap(Effect.service(AccountExitFence), (fence) =>
    Effect.acquireUseRelease(
      fence.exclusive(
        Effect.flatMap(
          Effect.service(DeviceOnboardingDraft),
          (storage) => storage.clear
        ).pipe(
          Effect.andThen(
            sessionId === undefined
              ? Effect.void
              : fence.pauseOnboarding(sessionId)
          )
        )
      ),
      () => signOut,
      () =>
        sessionId === undefined
          ? Effect.void
          : fence.exclusive(fence.resumeOnboarding(sessionId))
    )
  );

export const confirmsSignOut = (
  error: { readonly status?: number } | null | undefined
) => error == null || error.status === 401;

const discardDraft = (
  shouldClear: Parameters<typeof clearDeviceOnboardingDraft>[1]
) =>
  Effect.flatMap(Effect.service(DeviceOnboardingDraft), (storage) =>
    clearDeviceOnboardingDraft(storage, shouldClear)
  );

// Removes the account's data unless a later session of it has opened.
const accountExitCleanup = (session: AccountSession) =>
  closeForExit(session).pipe(
    Effect.tap(() =>
      discardDraft((owner) =>
        Effect.succeed(
          owner.accountId === session.accountId &&
            (session.sessionId === undefined
              ? owner.sessionStartedAt <= session.sessionStartedAt
              : owner.sessionId === session.sessionId)
        )
      )
    ),
    Effect.flatMap((closed) =>
      closed ? removeAccountData(session) : Effect.void
    )
  );

const closeForExit = (session: AccountSession) =>
  Effect.flatMap(Effect.service(AccountExitFence), (fence) =>
    fence.close(session)
  );

const removeAccountData = ({ accountId }: AccountSession) =>
  removeStorageKeys((key) => isAccountStorageKey(key, accountId)).pipe(
    Effect.andThen(sweepUnheldFiles(Option.some(accountId)))
  );

// Removes what earlier accounts left, keeping the entries an open session
// owns. Its live files are held, so the sweep spares them.
const deviceExitCleanup = Effect.Do.pipe(
  Effect.bind("open", () => openAccounts),
  Effect.tap(() =>
    Effect.flatMap(Effect.service(DeviceOnboardingDraft), (storage) =>
      Effect.flatMap(Effect.service(AccountExitFence), (fence) =>
        clearDeviceOnboardingDraft(storage, (owner) =>
          fence.isCurrent(owner).pipe(Effect.map((current) => !current))
        )
      )
    )
  ),
  Effect.tap(({ open }) => removeStorageKeys(isUnownedKey(open))),
  Effect.tap(() => sweepUnheldFiles(Option.none())),
  Effect.asVoid
);

const openAccounts = Effect.flatMap(
  Effect.service(AccountExitFence),
  (fence) => fence.openAccounts
);

const isUnownedKey = (open: ReadonlySet<string>) => {
  const owners = [...open];
  return (key: string) =>
    isExitClearedKey(key) &&
    !owners.some((accountId) => isAccountStorageKey(key, accountId));
};

// A storage failure leaves the keys for a later exit or launch.
const removeStorageKeys = (remove: (key: string) => boolean) =>
  Effect.Do.pipe(
    Effect.bind("storage", () => Effect.service(DeviceStorage)),
    Effect.bind("keys", ({ storage }) => storage.keys),
    Effect.tap(({ storage, keys }) => storage.removeItems(keys.filter(remove))),
    Effect.ignore
  );

// Sweeps now unless a share holds a file; then the release of the last held
// file sweeps them all.
const sweepUnheldFiles = (owner: Option.Option<string>) =>
  Effect.flatMap(Effect.service(TemporaryFiles), (files) =>
    files.sweep(owner)
  ).pipe(Effect.when(fileSweepNow), Effect.asVoid);

const fileSweepNow = Effect.flatMap(
  Effect.service(AccountExitFence),
  (fence) => fence.fileSweepNow
);

/** Who the app is signed in as, as far as exit cleanup cares. */
export type AccountPresence =
  | { readonly status: "restoring" }
  | { readonly status: "signed-out" }
  | ({ readonly status: "signed-in" } & AccountSession);

export const accountPresenceOf = (
  session: AuthSessionState
): AccountPresence =>
  session.status === "signed-in"
    ? {
        status: "signed-in",
        accountId: session.user.id,
        sessionStartedAt: session.signedInAt.getTime(),
      }
    : session;

/**
 * The exit that moving from `previous` to `next` means: the previous account
 * signed out or was replaced by another. Reauthentication of the same
 * account retires only the previous session's protected draft. A launch
 * that finds no session cleans the device, in case the last exit's cleanup
 * didn't finish or the session
 * expired while the app was closed; one that restores a session removes the
 * shared files a run that ended mid-share left.
 */
export const accountExitOf = (
  previous: AccountPresence,
  next: AccountPresence
): AccountExit | undefined => {
  if (next.status === "restoring") return undefined;
  if (previous.status === "signed-in") {
    if (next.status === "signed-out" || previous.accountId !== next.accountId) {
      return {
        scope: "account",
        accountId: previous.accountId,
        sessionStartedAt: previous.sessionStartedAt,
        ...(previous.sessionId === undefined
          ? {}
          : { sessionId: previous.sessionId }),
      };
    }
    if (
      previous.sessionId !== undefined &&
      next.sessionId !== undefined &&
      previous.sessionId !== next.sessionId
    )
      return { scope: "onboarding-session", sessionId: previous.sessionId };
    return undefined;
  }
  if (previous.status !== "restoring") return undefined;
  return next.status === "signed-out"
    ? { scope: "device" }
    : { scope: "shared-files" };
};
