import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import type {
  NavigationProp,
  ParamListBase,
} from "expo-router/react-navigation";
import { type ReactNode, useCallback, useRef } from "react";
import { useSessionReads } from "../../auth/use-session-reads";
import { AsyncView } from "../../customer-api/async-view";
import { accountAtom } from "../../customer-api/customer-data-runtime";
import { ScrollScreen } from "../../ui/scroll-screen";
import { QuietUpdateOffer } from "../../updates/update-offer-card";
import {
  completeProfileAtom,
  profileSubmitState,
} from "../profile/profile-save";
import type { CompletionRequiredAccount } from "./onboarding-draft";
import { completionDraftRecoveryAtom } from "./onboarding-edits";
import { onboardingView } from "./onboarding-model";
import { closeOnboarding, finishOnlyState } from "./onboarding-routes";

/**
 * An onboarding step for the account as GET /account reads it: the step's
 * form while the account needs a profile; the finish once this flow
 * created it, in place of the steps, so Back from the finish leaves
 * onboarding; and otherwise back to the screen onboarding opened over.
 * Only the step in view moves on, so one step navigates.
 */
export function OnboardingGate({
  children,
}: {
  readonly children: (account: CompletionRequiredAccount) => ReactNode;
}) {
  const account = useAtomValue(accountAtom);
  const refresh = useAtomRefresh(accountAtom);
  const completion = profileSubmitState(useAtomValue(completeProfileAtom));
  const current = Option.getOrUndefined(AsyncResult.value(account));
  if (current === undefined)
    return (
      <ScrollScreen>
        <QuietUpdateOffer backdrop="paper" />
        <AsyncView result={account} onRetry={refresh}>
          {() => null}
        </AsyncView>
      </ScrollScreen>
    );
  if (current.kind === "completion-required")
    return (
      <OnboardingDraftGate account={account} refresh={refresh}>
        {children(current)}
      </OnboardingDraftGate>
    );
  return onboardingView(current, completion) === "finish" ? (
    <ShowFinish />
  ) : (
    <LeaveOnboarding />
  );
}

function OnboardingDraftGate({
  account,
  refresh,
  children,
}: {
  readonly account: Atom.Type<typeof accountAtom>;
  readonly refresh: () => void;
  readonly children: ReactNode;
}) {
  const recovery = useAtomValue(completionDraftRecoveryAtom);
  const recovered = AsyncResult.isSuccess(recovery);
  const accountWaiting = account.waiting;
  const reads = useSessionReads();
  const lastAttempt = useRef(0);
  useFocusEffect(
    useCallback(() => {
      if (recovered || accountWaiting || reads === lastAttempt.current) return;
      lastAttempt.current = reads;
      refresh();
    }, [recovered, accountWaiting, reads, refresh])
  );
  if (recovered) return children;
  const pending = accountWaiting ? AsyncResult.waiting(recovery) : recovery;
  // The previous account can still choose this route after a failed refresh.
  // The retry card needs the failure without that previous success.
  const result = AsyncResult.isFailure(account)
    ? AsyncResult.failure(account.cause, { waiting: accountWaiting })
    : pending;
  return (
    <ScrollScreen>
      <AsyncView result={result} onRetry={refresh}>
        {() => null}
      </AsyncView>
    </ScrollScreen>
  );
}

function ShowFinish() {
  // The onboarding stack, whose steps the finish replaces.
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  useFocusEffect(
    useCallback(() => {
      const stack = navigation.getState();
      if (stack !== undefined) navigation.reset(finishOnlyState(stack));
    }, [navigation])
  );
  return null;
}

/** Leaves onboarding once in view, like a `Redirect` back out of the stack. */
export function LeaveOnboarding() {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const router = useRouter();
  useFocusEffect(
    useCallback(() => {
      closeOnboarding(navigation, router);
    }, [navigation, router])
  );
  return null;
}
