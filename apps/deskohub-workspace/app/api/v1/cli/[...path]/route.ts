import { handleWorkspaceAdminApiRequest } from "@/features/admin-cli/workspace-admin-api.server";
import {
  continueMutationsAfterDisconnect,
  defineWorkspaceHttpApiRoute,
} from "@/shared/backend/workspace-http-api-route";

export const GET = defineWorkspaceHttpApiRoute(
  {
    operation: "workspaceAdminApi",
    cancellation: "interrupt-on-disconnect",
    caller: "client",
    failureMessage: "The administration API request could not be completed.",
  },
  handleWorkspaceAdminApiRequest
);

const workspaceAdminApiMutationRoute = defineWorkspaceHttpApiRoute(
  {
    operation: "workspaceAdminApi",
    cancellation: "continue-after-disconnect",
    caller: "client",
    failureMessage: "The administration API request could not be completed.",
  },
  continueMutationsAfterDisconnect(handleWorkspaceAdminApiRequest)
);

export {
  workspaceAdminApiMutationRoute as DELETE,
  workspaceAdminApiMutationRoute as PATCH,
  workspaceAdminApiMutationRoute as POST,
  workspaceAdminApiMutationRoute as PUT,
};
