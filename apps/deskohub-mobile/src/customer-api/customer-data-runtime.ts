import { Effect, Layer } from "effect";
import { Atom } from "effect/reactivity";
import {
  clearStoredCompletionEdits,
  deferCompletionEdits,
  onboardingSessionIdAtom,
  restoreCompletionEdits,
} from "../account/onboarding/onboarding-edits";
import { withSessionWriteLock } from "../auth/session-write-lock";
import type { AccountReadBudget } from "./account-read-budget";
import {
  type AccountExitFence,
  AccountScopedStorage,
} from "./account-scoped-storage";
import {
  CustomerAccountScope,
  CustomerApi,
  type CustomerAuthApi,
  type CustomerSessionCheck,
} from "./customer-api.service";
import { customerRead } from "./customer-request";
import type { DeviceCapabilities } from "./device-capabilities";

/** Everything account screens' Effects may require. */
export type CustomerDataServices =
  | AccountScopedStorage
  | AccountExitFence
  | CustomerApi
  | CustomerAuthApi
  | CustomerAccountScope
  | CustomerSessionCheck
  | AccountReadBudget
  | DeviceCapabilities;

const notProvided: Layer.Layer<CustomerDataServices> = Layer.effectContext(
  Effect.die("The customer data layer is used outside CustomerDataProvider")
);

/**
 * The layer behind the account screens' data, set per registry:
 * `CustomerDataProvider` seeds the live layer for the signed-in account (or
 * the sample-data layer in development), tests seed fakes with
 * `Atom.initialValue`. Kept alive so it never falls back to the default.
 */
export const customerDataLayer = Atom.keepAlive(Atom.make(notProvided));

// Atom runtimes memoize layers in one MemoMap shared by every registry, so a
// static layer such as `AccountReadBudget.Default` built for one account would
// serve the next account while the first registry lives. Each registry builds
// its layer with a map of its own.
const builtPerRegistry = <A, E>(layer: Layer.Layer<A, E>) =>
  Layer.effectContext(
    Effect.Do.pipe(
      Effect.bind("memoMap", () => Layer.makeMemoMap),
      Effect.bind("scope", () => Effect.scope),
      Effect.flatMap(({ memoMap, scope }) =>
        Layer.buildWithMemoMap(layer, memoMap, scope)
      )
    )
  );

/**
 * The one runtime account screens run Effects in. Each signed-in account gets
 * its own registry, so caches, the read budget and in-flight requests never
 * cross accounts. Queries are `customerDataRuntime.atom(...)` (or a family of
 * them), mutations `customerDataRuntime.fn(...)`.
 */
export const customerDataRuntime = Atom.runtime((get) =>
  builtPerRegistry(get(customerDataLayer))
);

/**
 * The signed-in account (GET /account), which gates every section. Kept
 * alive for the account's registry; mutations that change it refresh it.
 */
export const accountAtom = customerDataRuntime
  .atom((get) => {
    const sessionId = get.once(onboardingSessionIdAtom);
    const read = Effect.flatMap(Effect.service(CustomerApi), (api) =>
      api.account.getAccount({ headers: {} })
    ).pipe(customerRead({ accountRead: true }));
    return Effect.flatMap(Effect.service(CustomerAccountScope), (scope) => {
      const reconcile = read.pipe(
        Effect.tap((account) => {
          if (get.once(onboardingSessionIdAtom) !== sessionId)
            return Effect.void;
          if (account.kind === "completion-required")
            return restoreCompletionEdits(get, sessionId);
          // A previous process may have stopped after the server created the profile.
          if (account.kind === "linked")
            return clearStoredCompletionEdits(sessionId);
          return Effect.flatMap(
            Effect.service(AccountScopedStorage),
            (storage) =>
              storage.restoreOnboardingDraft(sessionId).pipe(Effect.ignore)
          );
        })
      );
      // Keep the confirmed owner and the cookie used by this account read
      // together while native sign-in and sign-out can replace the cookie.
      return scope.confirmOnboardingSession === undefined
        ? reconcile
        : withSessionWriteLock(
            scope
              .confirmOnboardingSession(sessionId)
              .pipe(
                Effect.flatMap((verified) =>
                  verified
                    ? reconcile
                    : read.pipe(
                        Effect.tap((account) =>
                          account.kind === "completion-required"
                            ? deferCompletionEdits(get, sessionId)
                            : Effect.void
                        )
                      )
                )
              )
          );
    });
  })
  .pipe(Atom.keepAlive);
