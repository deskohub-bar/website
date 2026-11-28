import { Effect, Layer, Option, Schema } from "effect";
import * as SecureStore from "expo-secure-store";
import {
  DeviceCapabilityFailed,
  DeviceOnboardingDraft,
} from "./device-capabilities";

// SecureStore cannot enumerate keys. One slot holds the draft and its owner
// together, so a cold launch can check ownership or erase the whole slot.
const onboardingDraftKey = "deskohub.onboarding-draft.v1";
const onboardingDraftOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
const decodeOnboardingDraft = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      accountId: Schema.String,
      apiOrigin: Schema.String,
      sessionStartedAt: Schema.Finite,
      sessionId: Schema.String,
      draft: Schema.String,
    })
  )
);
const protectedStorage = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new DeviceCapabilityFailed({ capability: "storage" }),
  });
const clearOnboardingDraft = protectedStorage(() =>
  SecureStore.deleteItemAsync(onboardingDraftKey, onboardingDraftOptions)
);
export const deviceOnboardingDraftLayer = Layer.succeed(DeviceOnboardingDraft, {
  read: protectedStorage(() =>
    SecureStore.getItemAsync(onboardingDraftKey, onboardingDraftOptions)
  ).pipe(
    Effect.flatMap((stored): DeviceOnboardingDraft["Service"]["read"] => {
      if (stored === null) return Effect.succeed(Option.none());
      const entry = decodeOnboardingDraft(stored);
      return Option.isSome(entry)
        ? Effect.succeed(entry)
        : Effect.as(clearOnboardingDraft, Option.none());
    })
  ),
  write: (entry) =>
    protectedStorage(() =>
      SecureStore.setItemAsync(
        onboardingDraftKey,
        JSON.stringify(entry),
        onboardingDraftOptions
      )
    ),
  clear: clearOnboardingDraft,
});
