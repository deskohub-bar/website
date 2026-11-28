import { CustomerServiceUnavailable } from "@deskohub/workspace-customer-api";
import { Effect, Exit, Option, Schema } from "effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { AccountScopedStorage } from "../../customer-api/account-scoped-storage";
import { CompletionDraft } from "../profile/profile-draft";

const storedDraft = Schema.fromJsonString(CompletionDraft);
const decodeDraft = Schema.decodeUnknownOption(storedDraft);
const encodeDraft = Schema.encodeOption(storedDraft);

/** Both steps share the draft in the account's registry. */
export const completionEditsAtom = Atom.make(
  Option.none<CompletionDraft>()
).pipe(Atom.keepAlive);

export const completionDraftRecoveryAtom = Atom.make<
  AsyncResult.AsyncResult<void, CustomerServiceUnavailable>
>(AsyncResult.initial()).pipe(Atom.keepAlive);

export const onboardingSessionIdAtom = Atom.make<string | undefined>(
  undefined
).pipe(Atom.keepAlive);

export const setOnboardingSession = (
  registry: AtomRegistry.AtomRegistry,
  sessionId: string | undefined
) => {
  if (registry.get(onboardingSessionIdAtom) === sessionId) return;
  registry.set(onboardingSessionIdAtom, sessionId);
  registry.set(completionEditsAtom, Option.none());
  registry.set(completionDraftRecoveryAtom, AsyncResult.initial());
};

const recoveryUnavailable = () =>
  AsyncResult.fail(new CustomerServiceUnavailable({}));

/** Keep an unverified session from opening a form with empty defaults. */
export const deferCompletionEdits = (
  get: Atom.AtomContext,
  sessionId: string | undefined
) =>
  Effect.sync(() => {
    if (get.once(onboardingSessionIdAtom) !== sessionId) return;
    if (AsyncResult.isSuccess(get.once(completionDraftRecoveryAtom))) return;
    get.set(completionDraftRecoveryAtom, recoveryUnavailable());
  });

/** Restore once, before the first account read can open the form. */
export const restoreCompletionEdits = (
  get: Atom.AtomContext,
  sessionId: string | undefined
) =>
  Effect.exit(
    Effect.flatMap(Effect.service(AccountScopedStorage), (storage) =>
      storage.restoreOnboardingDraft(sessionId)
    )
  ).pipe(
    Effect.tap((restored) =>
      Effect.sync(() => {
        if (get.once(onboardingSessionIdAtom) !== sessionId) return;
        if (Exit.isFailure(restored)) {
          get.set(completionDraftRecoveryAtom, recoveryUnavailable());
          return;
        }
        if (Option.isNone(get.once(completionEditsAtom)))
          get.set(
            completionEditsAtom,
            Option.flatMap(restored.value, decodeDraft)
          );
        get.set(completionDraftRecoveryAtom, AsyncResult.success(undefined));
      })
    ),
    Effect.when(
      Effect.sync(
        () =>
          get.once(onboardingSessionIdAtom) === sessionId &&
          !AsyncResult.isSuccess(get.once(completionDraftRecoveryAtom))
      )
    ),
    Effect.asVoid
  );

export const saveCompletionEdits = ({
  draft,
  sessionId,
}: {
  readonly draft: CompletionDraft;
  readonly sessionId: string | undefined;
}) =>
  Effect.flatMap(Effect.service(AccountScopedStorage), (storage) =>
    Option.match(encodeDraft(draft), {
      onNone: () => Effect.void,
      onSome: (encoded) => storage.saveOnboardingDraft(encoded, sessionId),
    })
  );

export const clearStoredCompletionEdits = (sessionId: string | undefined) =>
  Effect.flatMap(Effect.service(AccountScopedStorage), (storage) =>
    storage.completeOnboardingDraft(sessionId)
  );
