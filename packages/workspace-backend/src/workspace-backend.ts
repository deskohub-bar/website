import { Config, Effect, Layer, Redacted } from "effect";
import { WorkspaceDatabase } from "./db/database.service";
import { databaseClient, databasePostgresLayer } from "./db/database-client";
import { CampaignUnsubscribeService } from "./features/email-campaigns/backend/campaign-unsubscribe.service";

const database = Layer.effect(
  WorkspaceDatabase,
  Effect.map(databaseClient, WorkspaceDatabase.make)
).pipe(
  Layer.provide(
    Layer.unwrap(
      Config.Redacted("DATABASE_URL").pipe(
        Effect.map((url) =>
          databasePostgresLayer({
            connectionString: Redacted.value(url),
            maxConnections: 8,
            applicationName: "deskohub-workspace-api",
          })
        )
      )
    )
  )
);

/** The Node API's request-independent dependencies, scoped to the process. */
export const WorkspaceBackendLive = CampaignUnsubscribeService.Configured.pipe(
  Layer.provideMerge(database)
);
