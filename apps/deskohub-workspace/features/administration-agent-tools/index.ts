import { Layer } from "effect";
import { AdministratorAgentAuthorization } from "@/features/administrators/backend/administrator-agent-authorization.service";
import { continueMutationsAfterDisconnect } from "@/shared/backend/workspace-http-api-route";
import { AdministrationAgentAccess } from "./administration-agent-access";
import { AdministrationAgentDocuments } from "./administration-agent-documents";
import {
  AdministrationApiClient,
  AdministrationApiTransport,
} from "./administration-api-client";
import { handleAssistantAdministrationRequest } from "./administration-assistant-api.server";

export { AdministrationAgentAccess } from "./administration-agent-access";

/**
 * The services the MCP route serves administration tools with: the access
 * check, the grant check each call runs, the links to documents, and the
 * client of the in-process administration API. Its mutations finish even
 * if the tool call is cancelled after dispatch.
 */
export const AdministrationAgentToolsLive = Layer.mergeAll(
  AdministrationAgentAccess.Live,
  AdministratorAgentAuthorization.Live,
  AdministrationAgentDocuments.Live,
  AdministrationApiClient.Default.pipe(
    Layer.provide(
      Layer.succeed(
        AdministrationApiTransport,
        continueMutationsAfterDisconnect(handleAssistantAdministrationRequest)
      )
    )
  )
);
