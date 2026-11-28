import {
  type CampaignOperations,
  type CliMutationInProgress,
  type CliMutationRejected,
  CurrentAdministrationCaller,
  campaignOperations,
  type LedgerOperationName,
  type OperationDecodedInput,
  type OperationOutput,
  OperationUnavailable,
} from "@deskohub/workspace-admin-api";
import { Effect, Schema } from "effect";
import type { CliStoredMutation } from "@/db/schema";
import {
  type DatabaseQueryError,
  isDatabaseQueryError,
} from "@/db/sql-constraint";
import type { OperationLedgerRequest } from "@/features/administration/administration-operation-port";
import type { OperationRequestLedger } from "@/features/email-campaigns/backend/operation-request-ledger.service";
import type { AdministrationRequestLedger } from "./administration-request-ledger.service";
import { toOperationLedgerFailure } from "./cli-administration-operations.server";

type CampaignLedgerOperation = LedgerOperationName<CampaignOperations>;

/**
 * The stored form of each ledger operation, by name. Typed per name, so an
 * operation's name picks the function for its own input.
 */
type StoredMutations = {
  readonly [Name in CampaignLedgerOperation]: (
    input: OperationDecodedInput<CampaignOperations[Name]>
  ) => CliStoredMutation;
};

/**
 * The stored form of each ledger operation. The kinds predate the port, so
 * a retry that spans a deployment still matches its first request.
 */
const storedMutations: StoredMutations = {
  createCampaignAudience: (input) => ({
    kind: "campaign-audience-create" as const,
    audience: input.audience,
  }),
  createCampaign: (input) => ({
    kind: "campaign-create" as const,
    campaign: input.campaign,
  }),
  duplicateCampaign: (input) => ({
    kind: "campaign-duplicate" as const,
    campaignId: input.campaignId,
  }),
};

/**
 * The result schema of each ledger operation, by name. Typed per name, so an
 * operation's name picks its own result schema.
 */
type CampaignResults = {
  readonly [Name in CampaignLedgerOperation]: CampaignOperations[Name]["output"];
};

const campaignResults: CampaignResults = {
  createCampaignAudience: campaignOperations.createCampaignAudience.output,
  createCampaign: campaignOperations.createCampaign.output,
  duplicateCampaign: campaignOperations.duplicateCampaign.output,
};

/**
 * The ledger's own failures as port errors. A ledger that can't be read or
 * replayed answers as the campaign port answers any unknown failure.
 */
const toCampaignLedgerFailure = <E>(
  error:
    | E
    | CliMutationInProgress
    | CliMutationRejected
    | DatabaseQueryError
    | Schema.SchemaError
) =>
  isDatabaseQueryError(error) || Schema.isSchemaError(error)
    ? new OperationUnavailable({
        code: "service-unavailable",
        message: "The campaign service is temporarily unavailable.",
        cause: error,
      })
    : toOperationLedgerFailure(error);

/**
 * The administration API's request ledger for one caller, stored with the
 * other administration requests under the caller's channel, so a retried
 * request replays its first result.
 */
export const cliOperationRequestLedger = (
  ledger: AdministrationRequestLedger["Service"],
  caller: CurrentAdministrationCaller["Service"]
): OperationRequestLedger["Service"] => ({
  applyOnce: <Name extends CampaignLedgerOperation, E, R>(
    entry: Extract<
      OperationLedgerRequest<CampaignOperations>,
      { readonly operation: Name }
    > & {
      readonly apply: Effect.Effect<
        OperationOutput<CampaignOperations[Name]>,
        E,
        R
      >;
    }
  ) =>
    ledger
      .applyOnce<OperationOutput<CampaignOperations[Name]>, E, R>({
        requestId: entry.input.requestId,
        mutation: storedMutations[entry.operation](entry.input),
        result: campaignResults[entry.operation],
        apply: entry.apply,
      })
      .pipe(
        Effect.mapError(toCampaignLedgerFailure),
        Effect.provideService(CurrentAdministrationCaller, caller)
      ),
});
