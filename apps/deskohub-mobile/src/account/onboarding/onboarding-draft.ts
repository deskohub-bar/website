import {
  accountPhoneRegion,
  type CustomerAccountState,
} from "@deskohub/workspace-customer-api";
import {
  RegistryContext,
  useAtom,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";
import { customerDataRuntime } from "../../customer-api/customer-data-runtime";
import { useDeviceCountry } from "../../i18n/device-locale";
import type {
  CompletionDraft,
  CompletionTextField,
} from "../profile/profile-draft";
import {
  completeProfileAtom,
  currentCompletionDraft,
  invitationCodeOf,
  profileSubmitState,
} from "../profile/profile-save";
import {
  completionDraftRecoveryAtom,
  completionEditsAtom,
  onboardingSessionIdAtom,
  saveCompletionEdits,
} from "./onboarding-edits";

/** An account that has a verified email but no customer profile yet. */
export type CompletionRequiredAccount = Extract<
  CustomerAccountState,
  { kind: "completion-required" }
>;

// Account storage serializes writes with one another and with sign-out.
export const saveCompletionEditsAtom = customerDataRuntime
  .fn(saveCompletionEdits, { concurrent: true })
  .pipe(Atom.keepAlive);

/**
 * The completion draft both onboarding steps edit, and its one submit
 * (POST /account/profile through `completeProfileAtom`). The draft lives in
 * `completionEditsAtom`, so it outlasts the steps: moving between them,
 * reopening onboarding keeps what was typed. Native restores saved edits
 * when the signed-in account first loads.
 */
export function useOnboardingDraft(account: CompletionRequiredAccount) {
  const invitationCode = invitationCodeOf(account);
  const phoneRegion = accountPhoneRegion(account.locale);
  const deviceCountry = useDeviceCountry();
  const registry = useContext(RegistryContext);
  const sessionId = useAtomValue(onboardingSessionIdAtom);
  const mayEdit = () =>
    registry.get(onboardingSessionIdAtom) === sessionId &&
    AsyncResult.isSuccess(registry.get(completionDraftRecoveryAtom));
  const [edits, setEdits] = useAtom(completionEditsAtom);
  const saveEdits = useAtomSet(saveCompletionEditsAtom);
  const result = useAtomValue(completeProfileAtom);
  const complete = useAtomSet(completeProfileAtom);
  const draft = currentCompletionDraft(edits, invitationCode, deviceCountry);
  // The last submit's message and field problems no longer describe it.
  const resetSubmit = () => {
    if (!result.waiting) complete(Atom.Reset);
  };
  const change = (change: Partial<CompletionDraft>) => {
    if (!mayEdit()) return;
    setEdits((latest) => {
      const next = {
        ...currentCompletionDraft(latest, invitationCode, deviceCountry),
        ...change,
      };
      saveEdits({ draft: next, sessionId });
      return Option.some(next);
    });
    resetSubmit();
  };
  return {
    draft,
    invitationCode,
    phoneRegion,
    state: profileSubmitState(result),
    /** Changes several fields at once, as an applied company lookup does. */
    change,
    setField: (field: CompletionTextField, value: string) =>
      change({ [field]: value }),
    resetSubmit,
    submit: () => {
      if (mayEdit()) complete({ draft, invitationCode, phoneRegion });
    },
  };
}
