import { Effect, Layer } from "effect";
import { Platform } from "react-native";
import { AccountExitFence } from "../customer-api/account-scoped-storage";
import { deviceOnboardingDraftLayer } from "../customer-api/device-onboarding-draft-layer";
import { eraseDraftForSignOut } from "../customer-api/exit-cleanup";
import { authClient } from "./auth-client";
import { SignOutFailure, signOutOf } from "./sign-out-request";

export { SignOutFailure } from "./sign-out-request";

const withNativeDraftErased = (request: Effect.Effect<void, SignOutFailure>) =>
  Effect.suspend(() =>
    eraseDraftForSignOut(
      authClient.$store.atoms.session?.get().data?.session.id,
      request
    )
  ).pipe(
    Effect.provide(
      Layer.merge(deviceOnboardingDraftLayer, AccountExitFence.Default)
    ),
    Effect.mapError(() => new SignOutFailure())
  );

/** Ends the session under the auth write lock after erasing the native draft. */
export const signOut = signOutOf(
  authClient,
  Platform.OS === "web" ? undefined : withNativeDraftErased
);
