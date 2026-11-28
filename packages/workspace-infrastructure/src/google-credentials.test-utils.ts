import { Credentials, CredentialsFromEnv } from "@alchemy.run/gcp";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

const environmentLookup = Effect.runSync(
  Effect.service(Credentials).pipe(Effect.provide(CredentialsFromEnv))
);

/**
 * A token lookup that fails with the provider's own credentials error, its
 * cause carrying `detail`, so tests can check the detail never leaks.
 */
export const refusedCredentials = (
  detail: string
): typeof Credentials.Service =>
  environmentLookup.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.make(() =>
        Effect.fail(new ConfigProvider.SourceError({ message: detail }))
      )
    )
  );
