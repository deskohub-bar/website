import "server-only";

import {
  type AdministrationOperationError,
  campaignOperations,
  OperationInputInvalid,
} from "@deskohub/workspace-admin-api";
import { Effect, Match, Schema, Struct } from "effect";
import {
  type AdministrationPath,
  administrationHref,
} from "@/features/administration/administration-href";
import { defineAdministrationAction } from "@/features/administrators/server/administration-request.server";
import { CampaignOperations } from "../backend/campaign-operations.service";
import { emailCampaignsActionFailureCopy } from "./campaign-operation-failure";
import { campaignOperationCapabilities } from "./campaign-operation-query.server";
import type { CampaignOperationResult } from "./campaign-operations.actions";

const campaignOperationNames = Struct.keys(campaignOperations);

/**
 * Which operation to run, with its input as the client sent it. The port
 * decodes the input, so invalid input fails as it does for every adapter.
 */
const CampaignOperationRequest = Schema.Struct({
  operation: Schema.Unknown.pipe(
    Schema.decodeTo(Schema.Literals(campaignOperationNames))
  ),
  input: Schema.Unknown,
});

const toFailure = (
  error: AdministrationOperationError
): CampaignOperationResult => ({
  _tag: "Failure",
  category: error._tag,
  code: error.code,
  message: error.message,
});

const administratorRequired: CampaignOperationResult = {
  _tag: "Failure",
  category: "OperationUnauthorized",
  code: "administrator-required",
  message: "Administrator authentication is required.",
};

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

/**
 * The input in its operation's encoded shape, which the port takes. Input
 * without that shape fails here as the port's strict decode would report it;
 * the port still re-checks the administrator grant and decodes every input
 * that has the shape, refinements included. Input without the shape so fails
 * before the grant re-check, outside the port's span: a caller whose grant
 * was revoked learns only that the shape is wrong.
 */
const encodedInput = ({
  operation,
  input,
}: typeof CampaignOperationRequest.Type) =>
  Schema.decodeUnknownEffect(
    Schema.toEncoded(campaignOperations[operation].input)
  )(input, strictParseOptions).pipe(
    Effect.mapError(
      (cause) =>
        new OperationInputInvalid({
          code: "input-invalid",
          message: `The input is invalid: ${cause.message}`,
        })
    )
  );

/** Runs the operation through the port, with its failure as data. */
const operationResult = (request: typeof CampaignOperationRequest.Type) =>
  encodedInput(request).pipe(
    Effect.flatMap((input) =>
      CampaignOperations.pipe(
        Effect.flatMap((operations) =>
          operations.invoke(request.operation, input)
        )
      )
    ),
    Effect.match({
      onFailure: toFailure,
      onSuccess: (output): CampaignOperationResult => ({
        _tag: "Success",
        output,
      }),
    })
  );

/** An operation input about one campaign or one audience, as sent. */
const isCampaignInput = Schema.is(Schema.Struct({ campaignId: Schema.String }));
const isAudienceInput = Schema.is(Schema.Struct({ audienceId: Schema.String }));

/** Every page that lists or shows what a campaign mutation can change. */
const campaignPages = ({
  input,
}: typeof CampaignOperationRequest.Type): readonly AdministrationPath[] => [
  administrationHref("/[locale]/admin/email-campaigns"),
  administrationHref("/[locale]/admin/email-audiences"),
  ...Match.value(input).pipe(
    Match.when(isCampaignInput, ({ campaignId }) => [
      administrationHref("/[locale]/admin/email-campaigns/[campaignId]", {
        campaignId,
      }),
    ]),
    Match.when(isAudienceInput, ({ audienceId }) => [
      administrationHref("/[locale]/admin/email-audiences/[audienceId]", {
        audienceId,
      }),
    ]),
    Match.orElse(() => [])
  ),
];

export const campaignOperationAction = defineAdministrationAction(
  {
    operation: "email-campaigns.admin.run-operation",
    schema: Schema.toStandardSchemaV1(CampaignOperationRequest, {
      parseOptions: { errors: "all", onExcessProperty: "error" },
    }),
    // Inputs can hold test recipients' addresses.
    logInput: false,
    failureCopy: emailCampaignsActionFailureCopy,
    capabilities: campaignOperationCapabilities,
    unauthorizedResult: administratorRequired,
    revalidates: (request, result) =>
      result._tag === "Success" &&
      campaignOperations[request.operation].kind === "mutation"
        ? campaignPages(request)
        : [],
  },
  operationResult
);
