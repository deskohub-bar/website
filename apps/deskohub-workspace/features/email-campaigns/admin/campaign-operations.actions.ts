"use server";

import {
  type AdministrationOperationError,
  type CampaignOperationName,
  type CampaignOperations as CampaignOperationRegistry,
  campaignOperations,
  type OperationInput,
  type OperationOutput,
} from "@deskohub/workspace-admin-api";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { Schema } from "effect";
import type {
  FlattenedValidationErrors,
  SafeActionResult,
  ValidationErrors,
} from "next-safe-action";
import { campaignOperationAction } from "./campaign-operation-action.server";

export type CampaignOperationRequest<
  Name extends CampaignOperationName = CampaignOperationName,
> = {
  readonly operation: Name;
  readonly input: OperationInput<CampaignOperationRegistry[Name]>;
};

/**
 * An operation's output, or its failure as data: the category, the stable
 * `code` the admin UI localizes, and the English message as a fallback.
 */
export type CampaignOperationResult<
  Name extends CampaignOperationName = CampaignOperationName,
> =
  | {
      readonly _tag: "Success";
      readonly output: OperationOutput<CampaignOperationRegistry[Name]>;
    }
  | {
      readonly _tag: "Failure";
      readonly category: AdministrationOperationError["_tag"];
      readonly code: string;
      readonly message: string;
    };

export type CampaignOperationRequestSchema<
  Name extends CampaignOperationName = CampaignOperationName,
> = StandardSchemaV1<CampaignOperationRequest<Name>>;

export type CampaignOperationValidationErrors<
  Name extends CampaignOperationName = CampaignOperationName,
> = FlattenedValidationErrors<
  ValidationErrors<CampaignOperationRequestSchema<Name>>
>;

/**
 * What the client receives for one operation: the action envelope, whose
 * `data` is the operation's result.
 */
type CampaignOperationActionResult<Name extends CampaignOperationName> =
  SafeActionResult<
    string,
    CampaignOperationRequestSchema<Name>,
    CampaignOperationValidationErrors<Name>,
    CampaignOperationResult<Name>
  >;

/**
 * Runs one campaign operation through the port for the signed-in
 * administrator. A mutation that succeeds revalidates the campaign pages.
 */
export async function runCampaignOperation<Name extends CampaignOperationName>(
  request: CampaignOperationRequest<Name>
): Promise<CampaignOperationActionResult<Name>> {
  "use server";
  const result = await campaignOperationAction(request);
  if (result.data === undefined) return result;
  return { ...result, data: operationResultOf(request.operation, result.data) };
}

/**
 * The result typed by its operation. The action answers for every operation
 * at once, so a success's output is checked against its own operation's
 * output schema; an output that fails it is a contract bug the client must
 * not trust, reported as the operation being unavailable.
 */
const operationResultOf = <Name extends CampaignOperationName>(
  operation: Name,
  result: CampaignOperationResult
): CampaignOperationResult<Name> => {
  if (result._tag === "Failure") return result;
  const { output } = result;
  return Schema.is(campaignOperations[operation].output)(output)
    ? { _tag: "Success", output }
    : {
        _tag: "Failure",
        category: "OperationUnavailable",
        code: "output-invalid",
        message: "The operation returned an output its schema rejects.",
      };
};
