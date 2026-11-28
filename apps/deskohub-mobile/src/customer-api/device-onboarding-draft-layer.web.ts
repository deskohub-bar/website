import { Effect, Layer, Option } from "effect";
import { DeviceOnboardingDraft } from "./device-capabilities";

export const deviceOnboardingDraftLayer = Layer.succeed(DeviceOnboardingDraft, {
  read: Effect.succeed(Option.none()),
  write: () => Effect.void,
  clear: Effect.void,
});
