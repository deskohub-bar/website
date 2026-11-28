import { mock } from "bun:test";
import type {
  AdministrationCampaignAudienceType,
  AdministrationOperationError,
  CampaignOperationName,
  CampaignOperations as CampaignOperationRegistry,
  OperationInput,
} from "@deskohub/workspace-admin-api";
import { Context, Effect, Layer } from "effect";
import { mockAdministratorAccess } from "@/features/administrators/server/administrator-access.test-utils";
import type { ICampaignOperations } from "../backend/campaign-operations.service";
import type { CampaignAudienceId } from "../campaign-identifiers";
import type { invokeCampaignOperation } from "./campaign-operation-query.server";

class StubCampaignOperations extends Context.Service<
  StubCampaignOperations,
  ICampaignOperations
>()("@test/CampaignOperations") {}

type Invocation = {
  readonly name: CampaignOperationName;
  readonly input: OperationInput<
    CampaignOperationRegistry[CampaignOperationName]
  >;
};

type QueryResponses = {
  [Name in CampaignOperationName]?: Effect.Effect<
    Effect.Success<ReturnType<typeof invokeCampaignOperation<Name>>>,
    AdministrationOperationError
  >;
};

type QueryPort = {
  readonly access: ReturnType<typeof mockAdministratorAccess>;
  responses: QueryResponses;
  readonly invoked: Invocation[];
};

export const campaignAudienceFixture = (
  id: CampaignAudienceId,
  title: string,
  archivedAt: string | null = null
): AdministrationCampaignAudienceType => ({
  id,
  title,
  archivedAt,
  filter: {
    _tag: "Condition",
    attribute: "locale",
    operator: "anyOf",
    value: ["cs-CZ"],
  },
  createdAt: "2026-10-01T08:00:00Z",
  updatedAt: "2026-10-01T08:00:00Z",
});

/**
 * Stubs the campaign operation port and the session behind the page gate for
 * page-load tests. Call it before importing the loader; set `responses` per
 * operation name, read the names the loader invoked, in order, from
 * `invoked`, and set who the request acts as through `access`.
 */
export const stubCampaignPageQueries = () => {
  const access = mockAdministratorAccess("campaign-page-actor");
  const port: QueryPort = {
    access,
    responses: {},
    invoked: [],
  };

  mock.module(
    "@/features/email-campaigns/backend/campaign-operations.service",
    () => ({
      CampaignOperations: Object.assign(StubCampaignOperations, {
        Live: Layer.succeed(
          StubCampaignOperations,
          StubCampaignOperations.of({
            invoke: (name, input) => {
              port.invoked.push({ name, input });
              return port.responses[name] ?? Effect.die(`unexpected ${name}`);
            },
          })
        ),
      }),
    })
  );
  mock.module("next/headers", () => ({
    cookies: async () => ({ get: () => undefined, getAll: () => [] }),
    headers: async () =>
      new Headers({ referer: "https://deskohub.test/en-US/admin" }),
  }));
  mock.module("next/server", () => ({
    after: () => undefined,
    connection: () => Promise.resolve(),
  }));

  return port;
};
