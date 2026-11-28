import {
  AdminCliCampaignsApi,
  type AdministrationCampaignSendStatusResultType,
  operationGroupHandlers,
  WorkspaceAdminApi,
} from "@deskohub/workspace-admin-api";
import { Effect } from "effect";
import { cliCampaignOperationInvoker } from "./cli-campaign-operations.server";

/**
 * Every campaign endpoint is the port's operation of the same name: the
 * session's administrator, the session's mutation ledger, and the input the
 * request carries.
 */
export const AdminCliCampaignsApiHandlers = operationGroupHandlers(
  WorkspaceAdminApi,
  AdminCliCampaignsApi,
  cliCampaignOperationInvoker,
  {
    getCampaignSendStatus: (
      result: AdministrationCampaignSendStatusResultType
    ) =>
      Effect.succeed({
        send: result.send && {
          ...result.send,
          // Released CLI binaries decode skip reasons as a closed set.
          recipients: result.send.recipients.map((recipient) =>
            recipient.skipReason === "missing-email-language"
              ? { ...recipient, skipReason: null }
              : recipient
          ),
        },
      }),
  }
);
