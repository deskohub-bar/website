import "server-only";

import { Duration, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { env } from "@/env";
import { shareUntilShutdown } from "@/shared/backend/share-across-requests";
import { onRuntimeShutdown } from "@/shared/deployment/runtime-lifecycle";
import { WorkspaceDatabase } from "./database.service";
import {
  databaseClient,
  databasePostgresLayer,
  makeDatabasePool,
} from "./database-client";
import {
  databaseIdleCloseMillis,
  databaseIdleTimeout,
  databasePoolTimeouts,
} from "./database-pool-timeouts";
import { attachDatabaseReleaseReporter } from "./database-release-reporter";
import { WorkspaceDatabaseAdvisoryLock } from "./postgres-advisory-lock";

/**
 * Connections per function instance: the Workspace's native pool and Better
 * Auth's pool together open at most 10, as the one pool they shared did.
 * Sections take at most half of the Workspace's (`WorkspaceDatabaseAdvisoryLock`).
 */
const workspaceDatabaseConnections = 8;
const authDatabaseConnections = 2;

/** Both pools report each released connection, so Vercel waits for them. */
const reportRelease = attachDatabaseReleaseReporter(databaseIdleCloseMillis);

/** Better Auth's own node-postgres pool (drizzle node-postgres). */
export const authDatabasePool = makeDatabasePool({
  connectionString: env.DATABASE_URL,
  ...databasePoolTimeouts,
  max: authDatabaseConnections,
  idleTimeoutMillis: Duration.toMillis(databaseIdleTimeout),
});
authDatabasePool.on("release", reportRelease);
// A container closes Better Auth's connections last when it shuts down; on
// Vercel the hook never runs.
onRuntimeShutdown({
  name: "database.auth-pool",
  stage: "close",
  run: () => authDatabasePool.end(),
});

/** The Workspace's native pool, opened once per process. */
const workspacePostgresPool = shareUntilShutdown(
  databasePostgresLayer({
    connectionString: env.DATABASE_URL,
    maxConnections: workspaceDatabaseConnections,
    onRelease: reportRelease,
  })
);
const workspacePostgres = workspacePostgresPool.layer;
// A container closes the Workspace's connections, like Better Auth's, once
// its requests have drained.
onRuntimeShutdown({
  name: "database.workspace-pool",
  stage: "close",
  run: workspacePostgresPool.close,
});

export const workspaceDatabaseLayer = Layer.effect(
  WorkspaceDatabase,
  Effect.map(databaseClient, WorkspaceDatabase.make)
).pipe(Layer.provide(workspacePostgres));

export const workspaceDatabaseAdvisoryLockLayer = Layer.effect(
  WorkspaceDatabaseAdvisoryLock,
  Effect.map(SqlClient.SqlClient, (client) =>
    WorkspaceDatabaseAdvisoryLock.make({
      client,
      maxConnections: workspaceDatabaseConnections,
    })
  )
).pipe(Layer.provide(workspacePostgres));
