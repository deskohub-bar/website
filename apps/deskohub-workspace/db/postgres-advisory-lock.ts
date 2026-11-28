import { WorkspaceDatabaseAdvisoryLock as DatabaseCapability } from "@deskohub/workspace-backend/db/postgres-advisory-lock";
import { Effect, Layer } from "effect";

export {
  type PostgresAdvisoryLockConnections,
  type PostgresAdvisoryLockKey,
  withPostgresAdvisoryLock,
  withPostgresAdvisoryLocks,
} from "@deskohub/workspace-backend/db/postgres-advisory-lock";

export class WorkspaceDatabaseAdvisoryLock extends DatabaseCapability {
  static Default = Layer.unwrap(
    Effect.promise(async () => {
      const { workspaceDatabaseAdvisoryLockLayer } = await import(
        "./database-provider.server"
      );
      return workspaceDatabaseAdvisoryLockLayer;
    })
  );
}
