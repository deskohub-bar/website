import { WorkspaceDatabase as DatabaseCapability } from "@deskohub/workspace-backend/db/database.service";
import { Effect, Layer } from "effect";

export {
  type WorkspaceDatabaseClient,
  WorkspaceTransaction,
  workspaceStatementConcurrency,
} from "@deskohub/workspace-backend/db/database.service";

export class WorkspaceDatabase extends DatabaseCapability {
  static Default = Layer.unwrap(
    Effect.promise(async () => {
      const { workspaceDatabaseLayer } = await import(
        "./database-provider.server"
      );
      return workspaceDatabaseLayer;
    })
  );
}
