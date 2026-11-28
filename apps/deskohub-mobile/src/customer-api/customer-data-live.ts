import { Effect, Layer } from "effect";
import { Platform } from "react-native";
import { apiOrigin, authClient } from "../auth/auth-client";
import { AccountReadBudget } from "./account-read-budget";
import {
  type AccountSession,
  accountDeviceLayer,
} from "./account-scoped-storage";
import {
  CustomerAccountScope,
  CustomerApi,
  CustomerAuthApi,
  CustomerSessionCheck,
} from "./customer-api.service";
import { customerApiTransportLayer } from "./customer-api-transport";
import type { CustomerDataServices } from "./customer-data-runtime";
import { deviceCapabilitiesLayer } from "./device-capabilities-layer";

/**
 * The production data layer for one signed-in account. A 401 asks the
 * Better Auth client to read the session again (the same signal its own
 * session hooks use), so the guard redirects only once the session is gone.
 */
export const liveCustomerDataLayer = ({
  accountId,
  sessionStartedAt,
}: AccountSession): Layer.Layer<CustomerDataServices> => {
  const sessionId = () => {
    const session = authClient.$store.atoms.session?.get().data;
    return session?.user.id === accountId ? session.session.id : undefined;
  };
  const confirmOnboardingSession = (id: string | undefined) =>
    Effect.suspend(() => {
      const store = authClient.$store.atoms.session;
      const initial = store?.get();
      if (id === undefined || !store || !initial) return Effect.succeed(false);
      const confirmed = () => {
        const settled = store.get();
        return (
          settled.error == null &&
          !settled.isPending &&
          !settled.isRefetching &&
          sessionId() === id
        );
      };
      if (initial.isPending || initial.isRefetching)
        return Effect.callback<boolean>((resume) => {
          const stop = store.listen(() => {
            const current = store.get();
            if (!current.isPending && !current.isRefetching) {
              stop();
              resume(Effect.succeed(confirmed()));
            }
          });
          return Effect.sync(stop);
        });
      return initial.error == null
        ? Effect.sync(confirmed)
        : Effect.tryPromise(() => initial.refetch()).pipe(
            Effect.map(confirmed)
          );
    }).pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => false)
    );
  return Layer.mergeAll(
    Layer.mergeAll(CustomerApi.Default, CustomerAuthApi.Default).pipe(
      Layer.provide(customerApiTransportLayer)
    ),
    AccountReadBudget.Default,
    Layer.succeed(CustomerSessionCheck, {
      recheck: Effect.sync(() => authClient.$store.notify("$sessionSignal")),
    }),
    accountDeviceLayer(deviceCapabilitiesLayer).pipe(
      Layer.provideMerge(
        Layer.succeed(CustomerAccountScope, {
          accountId,
          apiOrigin,
          sessionStartedAt,
          ...(Platform.OS === "web"
            ? {}
            : {
                onboardingSession: Effect.sync(sessionId),
                confirmOnboardingSession,
              }),
        })
      )
    )
  );
};
