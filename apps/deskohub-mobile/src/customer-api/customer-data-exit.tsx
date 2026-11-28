import { useAtomSet } from "@effect/atom-react";
import { Layer } from "effect";
import { Atom } from "effect/reactivity";
import { type ReactNode, useEffect, useRef } from "react";
import { authClient } from "../auth/auth-client";
import { toAuthSessionState } from "../auth/auth-session-state";
import { AccountExitFence } from "./account-scoped-storage";
import { deviceCapabilitiesLayer } from "./device-capabilities-layer";
import {
  type AccountExit,
  type AccountPresence,
  accountExitOf,
  confirmsSignOut,
  customerDataExitCleanup,
} from "./exit-cleanup";

// Exit cleanup outlives the account's own registry, which unmounts with the
// signed-in screens, so it runs on the device capabilities alone.
const exitCleanupRuntime = Atom.runtime(
  Layer.merge(deviceCapabilitiesLayer, AccountExitFence.Default)
);
// Concurrent: a second exit (a quick switch, then sign-out) must not
// interrupt the first one's cleanup.
const exitCleanupAtom = exitCleanupRuntime.fn(
  (exit: AccountExit) => customerDataExitCleanup(exit),
  { concurrent: true }
);

/**
 * Mounted above the signed-in screens: when an account exits (sign-out,
 * expiry, switch) it clears that account's cached data and shared files, and
 * at launch it sweeps shared files a previous run left behind. Files an open
 * share still holds are swept once that share releases them. The account's
 * registry resets on its own, keyed by account id.
 */
export function CustomerDataExitCleanup({
  children,
}: {
  readonly children: ReactNode;
}) {
  const snapshot = authClient.useSession();
  const session = toAuthSessionState(snapshot);
  const cleanUp = useAtomSet(exitCleanupAtom);
  const previous = useRef<AccountPresence>({ status: "restoring" });
  const status = session.status;
  const signedOutConfirmed = confirmsSignOut(snapshot.error);
  const accountId = session.status === "signed-in" ? session.user.id : "";
  const sessionId = snapshot.data?.session.id;
  const sessionStartedAt =
    session.status === "signed-in" ? session.signedInAt.getTime() : 0;

  useEffect(() => {
    // A failed launch read does not establish that the stored session ended.
    if (
      status === "restoring" ||
      (status === "signed-out" && !signedOutConfirmed)
    )
      return;
    const next: AccountPresence =
      status === "signed-in"
        ? {
            status,
            accountId,
            sessionStartedAt,
            ...(sessionId === undefined ? {} : { sessionId }),
          }
        : { status };
    const exit = accountExitOf(previous.current, next);
    if (exit !== undefined) cleanUp(exit);
    previous.current = next;
  }, [
    status,
    accountId,
    sessionId,
    sessionStartedAt,
    signedOutConfirmed,
    cleanUp,
  ]);

  return children;
}
