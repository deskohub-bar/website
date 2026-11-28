import type { CDPSession, Page } from "@playwright/test";
import { Schema } from "effect";

/**
 * A platform passkey authenticator as Chromium's WebAuthn domain emulates it:
 * a CTAP2 internal authenticator that stores discoverable credentials and
 * verifies the user. It runs the browser's real origin and RP ID checks,
 * unlike Playwright's credential mocks, so a ceremony against the deployed
 * host proves its WebAuthn config.
 *
 * It starts without simulated presence. With presence on, Chromium answers a
 * conditional (autofill) request as it starts, so every sign-in form would
 * sign the customer straight back in. Without it, requests wait the way they
 * do for a customer who ignores the browser's passkey autofill, and a test
 * turns presence on only for the ceremony it drives.
 */
export const virtualPlatformAuthenticatorOptions = {
  automaticPresenceSimulation: false,
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  protocol: "ctap2",
  transport: "internal",
} as const;

/**
 * What a test may read back about a stored credential. Credential IDs, user
 * handles, and private keys stay inside the authenticator.
 */
export type VirtualAuthenticatorCredential = {
  readonly isResidentCredential: boolean;
  readonly rpId: string | undefined;
};

export type VirtualAuthenticator = {
  readonly readCredentials: () => Promise<
    readonly VirtualAuthenticatorCredential[]
  >;
  /**
   * Simulates the customer's presence while `ceremony` runs, so the WebAuthn
   * requests it starts are answered. A conditional request already pending
   * stays pending, but one the page starts meanwhile is answered too.
   */
  readonly answerCeremony: <A>(ceremony: () => Promise<A>) => Promise<A>;
  /** Removes the authenticator and detaches its session; repeat calls no-op. */
  readonly remove: () => Promise<void>;
};

/** A virtual authenticator that also watches its page's WebAuthn requests. */
export type PageVirtualAuthenticator = VirtualAuthenticator & {
  /**
   * Waits until the current document has a pending conditional (autofill)
   * request. Presence answers a request that starts during a ceremony but
   * not one already pending, so a test that drives another ceremony waits
   * for the form's request first; the wait times out if no pending request
   * is observed. Only documents loaded after the authenticator was added are
   * watched.
   */
  readonly waitForConditionalRequest: (timeout: number) => Promise<void>;
  /**
   * Like `answerCeremony`, for a ceremony the customer starts with a button:
   * keeps simulated presence off until the page starts a modal sign-in
   * request (after any aborted conditional request has settled in Chromium),
   * then keeps presence on until `ceremony` finishes and fails unless the
   * only sign-in request answered meanwhile, across navigations, is that
   * modal one. Delaying presence until the modal request avoids racing a
   * conditional request that is still traversing Chromium's browser-side
   * dispatch, while leaving presence on afterwards still catches a
   * conditional request the page arms after a failed button ceremony.
   */
  readonly answerModalCeremony: <A>(ceremony: () => Promise<A>) => Promise<A>;
};

type VirtualAuthenticatorCommand =
  | "WebAuthn.addVirtualAuthenticator"
  | "WebAuthn.disable"
  | "WebAuthn.enable"
  | "WebAuthn.getCredentials"
  | "WebAuthn.removeVirtualAuthenticator"
  | "WebAuthn.setAutomaticPresenceSimulation";

declare const sendCommand: CDPSession["send"];
export type VirtualAuthenticatorSession = {
  readonly detach: CDPSession["detach"];
  readonly send: <Command extends VirtualAuthenticatorCommand>(
    ...args: Parameters<typeof sendCommand<Command>>
  ) => Promise<unknown>;
};

const isAuthenticator = Schema.is(
  Schema.Struct({ authenticatorId: Schema.String })
);

const hasStoredCredentials = Schema.is(
  Schema.Struct({
    credentials: Schema.Array(
      Schema.Struct({
        isResidentCredential: Schema.Boolean,
        rpId: Schema.optionalKey(Schema.String),
      })
    ),
  })
);

/** How a sign-in (`credentials.get`) request the page started settled. */
type WebAuthnSignInRequestOutcome = {
  readonly conditional: boolean;
  readonly answered: boolean;
};

const conditionalRequestCountKey = "deskohub.e2e.conditionalWebAuthnRequests";
const signInRequestBinding = "__deskohubE2EWebAuthnSignInRequestSettled";
const modalSignInPrepareBinding = "__deskohubE2EWebAuthnModalSignInPrepare";

/**
 * Runs in every new document: counts pending conditional WebAuthn requests,
 * reports how each sign-in request settles, and before a modal request waits
 * for any aborted conditional request to finish cancelling in Chromium and
 * asks the host to enable simulated presence when `answerModalCeremony` is
 * active. Serialized into the page, so it references no module scope.
 */
const watchSignInRequests = ({
  countKey,
  binding,
  prepareBinding,
}: {
  readonly countKey: string;
  readonly binding: string;
  readonly prepareBinding: string;
}) => {
  const count = Symbol.for(countKey);
  Reflect.set(globalThis, count, 0);
  const pendingConditionals = new Set<{
    readonly signal: AbortSignal | undefined;
    readonly settled: Promise<void>;
  }>();
  const get = CredentialsContainer.prototype.get;
  CredentialsContainer.prototype.get = function (options) {
    const conditional = options?.mediation === "conditional";
    const publicKey = options?.publicKey !== undefined;
    const invoke = () => {
      const request = get.call(this, options);
      if (publicKey) {
        let conditionalEntry:
          | {
              readonly signal: AbortSignal | undefined;
              readonly settled: Promise<void>;
            }
          | undefined;
        let markSettled: (() => void) | undefined;
        if (conditional) {
          Reflect.set(
            globalThis,
            count,
            Number(Reflect.get(globalThis, count)) + 1
          );
          const settled = new Promise<void>((resolve) => {
            markSettled = resolve;
          });
          conditionalEntry = {
            signal: options?.signal,
            settled,
          };
          pendingConditionals.add(conditionalEntry);
        }
        const report = (answered: boolean) => {
          if (conditional) {
            Reflect.set(
              globalThis,
              count,
              Number(Reflect.get(globalThis, count)) - 1
            );
            if (conditionalEntry !== undefined) {
              pendingConditionals.delete(conditionalEntry);
            }
            markSettled?.();
          }
          const settled = Reflect.get(globalThis, binding);
          if (typeof settled === "function") {
            void settled({ conditional, answered });
          }
        };
        request.then(
          (credential) => report(credential !== null),
          () => report(false)
        );
      }
      return request;
    };
    if (!publicKey || conditional) {
      return invoke();
    }
    const prepare = async () => {
      const aborted = [...pendingConditionals].filter(
        (entry) => entry.signal?.aborted === true
      );
      if (aborted.length > 0) {
        await Promise.all(aborted.map((entry) => entry.settled));
      }
      if (options?.signal?.aborted) return;
      const prepareModal = Reflect.get(globalThis, prepareBinding);
      if (typeof prepareModal === "function") {
        await prepareModal();
      }
    };
    return prepare().then(
      () => invoke(),
      () => invoke()
    );
  };
};

const hasConditionalRequest = (key: string) =>
  Number(Reflect.get(globalThis, Symbol.for(key)) ?? 0) > 0;

/** A modal ceremony that did not sign in alone; the message is fixed text. */
export class ModalCeremonyNotAlone extends Error {}

/**
 * Fails unless `outcomes` answered exactly one sign-in request, a modal one.
 */
const requireOnlyModalSignInAnswered = (
  outcomes: readonly WebAuthnSignInRequestOutcome[]
) => {
  const answered = outcomes.filter((outcome) => outcome.answered);
  if (answered.some((outcome) => outcome.conditional)) {
    throw new ModalCeremonyNotAlone(
      "a conditional sign-in request was answered"
    );
  }
  if (answered.length !== 1) {
    throw new ModalCeremonyNotAlone(
      `${answered.length} modal sign-in requests were answered, not one`
    );
  }
};

type WatchedPageState = {
  readonly outcomes: WebAuthnSignInRequestOutcome[];
  beforeModalSignIn: (() => Promise<void>) | undefined;
};

/** Each page's sign-in request state, recorded from its first watch. */
const watchedPages = new WeakMap<Page, WatchedPageState>();

const watchPage = async (page: Page) => {
  const recorded = watchedPages.get(page);
  if (recorded !== undefined) return recorded;
  const state: WatchedPageState = {
    outcomes: [],
    beforeModalSignIn: undefined,
  };
  watchedPages.set(page, state);
  // Page-lifetime (Playwright cannot remove init scripts or bindings).
  await page.exposeFunction(signInRequestBinding, (outcome: unknown) => {
    if (
      typeof outcome === "object" &&
      outcome !== null &&
      "conditional" in outcome &&
      "answered" in outcome
    ) {
      state.outcomes.push({
        conditional: outcome.conditional === true,
        answered: outcome.answered === true,
      });
    }
  });
  await page.exposeFunction(modalSignInPrepareBinding, async () => {
    await state.beforeModalSignIn?.();
  });
  await page.addInitScript(watchSignInRequests, {
    countKey: conditionalRequestCountKey,
    binding: signInRequestBinding,
    prepareBinding: modalSignInPrepareBinding,
  });
  return state;
};

/**
 * Pages that hold a virtual authenticator. Detaching any CDP session from a
 * page resets Chromium's virtual authenticator environment for that page,
 * which removes the authenticator and every credential it stores, so other
 * CDP users leave their sessions attached on these pages.
 */
const authenticatorPages = new WeakSet<Page>();

export const holdsVirtualAuthenticator = (page: Page) =>
  authenticatorPages.has(page);

/**
 * Adds a virtual platform authenticator to one page's target. It serves that
 * page across navigations until `remove` runs or the page closes.
 */
export const addVirtualAuthenticator = async (
  page: Page
): Promise<PageVirtualAuthenticator> => {
  const state = await watchPage(page);
  const authenticator = await attachVirtualAuthenticatorControl(
    await page.context().newCDPSession(page)
  );
  authenticatorPages.add(page);
  return {
    answerCeremony: authenticator.answerCeremony,
    readCredentials: authenticator.readCredentials,
    remove: async () => {
      try {
        await authenticator.remove();
      } finally {
        authenticatorPages.delete(page);
      }
    },
    waitForConditionalRequest: async (timeout) => {
      await page.waitForFunction(
        hasConditionalRequest,
        conditionalRequestCountKey,
        { timeout }
      );
    },
    answerModalCeremony: async (ceremony) => {
      const start = state.outcomes.length;
      let enablingPresence: Promise<void> | undefined;
      const enablePresence = () => {
        enablingPresence ??= authenticator.setPresence(true);
        return enablingPresence;
      };
      state.beforeModalSignIn = enablePresence;
      try {
        const result = await ceremony();
        requireOnlyModalSignInAnswered(state.outcomes.slice(start));
        return result;
      } finally {
        if (state.beforeModalSignIn === enablePresence) {
          state.beforeModalSignIn = undefined;
        }
        if (enablingPresence !== undefined) {
          await enablingPresence.catch(() => undefined);
          await authenticator.setPresence(false);
        }
      }
    },
  };
};

const attachVirtualAuthenticatorControl = async (
  session: VirtualAuthenticatorSession
): Promise<
  VirtualAuthenticator & {
    readonly setPresence: (enabled: boolean) => Promise<void>;
  }
> => {
  let authenticatorId: string;
  try {
    await session.send("WebAuthn.enable", { enableUI: false });
    const result = await session.send("WebAuthn.addVirtualAuthenticator", {
      options: virtualPlatformAuthenticatorOptions,
    });
    if (!isAuthenticator(result))
      throw new Error("Chromium returned an invalid virtual authenticator.");
    authenticatorId = result.authenticatorId;
  } catch (cause) {
    await session.detach().catch(() => undefined);
    throw cause;
  }

  const setPresence = async (enabled: boolean) => {
    await session.send("WebAuthn.setAutomaticPresenceSimulation", {
      authenticatorId,
      enabled,
    });
  };

  let removal: Promise<void> | undefined;
  return {
    setPresence,
    answerCeremony: async (ceremony) => {
      await setPresence(true);
      try {
        return await ceremony();
      } finally {
        await setPresence(false);
      }
    },
    readCredentials: async () => {
      const result = await session.send("WebAuthn.getCredentials", {
        authenticatorId,
      });
      if (!hasStoredCredentials(result))
        throw new Error("Chromium returned invalid virtual credentials.");
      return result.credentials.map((credential) => ({
        isResidentCredential: credential.isResidentCredential,
        rpId: credential.rpId,
      }));
    },
    remove: () => {
      removal ??= (async () => {
        try {
          await session.send("WebAuthn.removeVirtualAuthenticator", {
            authenticatorId,
          });
          await session.send("WebAuthn.disable");
        } finally {
          await session.detach();
        }
      })();
      return removal;
    },
  };
};

export const attachVirtualAuthenticator = async (
  session: VirtualAuthenticatorSession
): Promise<VirtualAuthenticator> => {
  const { answerCeremony, readCredentials, remove } =
    await attachVirtualAuthenticatorControl(session);
  return { answerCeremony, readCredentials, remove };
};
