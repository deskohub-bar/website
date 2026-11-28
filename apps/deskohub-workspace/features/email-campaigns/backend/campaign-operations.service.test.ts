import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import {
  AdministrationCampaignId,
  CliMutationRequestId,
  campaignOperations,
} from "@deskohub/workspace-admin-api";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Effect, Layer, Schema } from "effect";
import type { CampaignRow } from "@/db/schema";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { AccountRoleGrants } from "@/features/administrators/backend/account-role-grants.service";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import { campaignAudienceIdSchema } from "../campaign-identifiers";
import {
  CampaignDeliveryMismatch,
  CampaignNotFound,
  CampaignRecipientResolutionError,
  CampaignTestRecipientInvalid,
} from "../errors";
import { CampaignService } from "./campaign.service";
import { CampaignAudienceService } from "./campaign-audience.service";
import { CampaignOperations } from "./campaign-operations.service";
import { automationServiceStubs } from "./campaign-operations.test-utils";
import { CampaignRecipientService } from "./campaign-recipient.service";
import { CampaignSendService } from "./campaign-send.service";
import { CampaignSendStatusService } from "./campaign-send-status.service";
import { everyoneFilter } from "./email-campaigns.test-utils";
import { OperationRequestLedger } from "./operation-request-ledger.service";

const campaignId = AdministrationCampaignId.make(
  "01990000-0000-7000-8000-000000000001"
);
const createdAt = Temporal.Instant.from("2026-10-19T08:00:00Z");
const administrator = {
  accountId: customerAccountIdSchema.make("account-administrator"),
  email: testEmailAddress("campaign-operations-administrator"),
};

const campaignRow = (overrides: Partial<CampaignRow> = {}): CampaignRow => ({
  id: campaignId,
  title: "October news",
  purpose: "operational",
  templateKey: "workspace",
  content: {},
  audienceId: null,
  emailId: null,
  delivery: "once",
  status: "draft",
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

type Overrides = {
  readonly isAdministrator?: boolean;
  readonly campaigns?: Partial<CampaignService["Service"]>;
  readonly audiences?: Partial<CampaignAudienceService["Service"]>;
  readonly recipients?: Partial<CampaignRecipientService["Service"]>;
  readonly sending?: Partial<CampaignSendService["Service"]>;
  readonly ledger?: OperationRequestLedger["Service"];
};

const runOperations = <A, E>(
  operation: (
    operations: CampaignOperations["Service"]
  ) => Effect.Effect<A, E, CurrentAdministrator | OperationRequestLedger>,
  overrides: Overrides = {}
) =>
  CampaignOperations.pipe(
    Effect.flatMap(operation),
    Effect.provideService(CurrentAdministrator, administrator),
    Effect.provide(
      overrides.ledger
        ? Layer.succeed(OperationRequestLedger, overrides.ledger)
        : OperationRequestLedger.unscoped
    ),
    Effect.provide(
      CampaignOperations.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AccountRoleGrants, {
              has: () => Effect.succeed(overrides.isAdministrator ?? true),
            }),
            Layer.mock(CampaignService, overrides.campaigns ?? {}),
            Layer.mock(CampaignAudienceService, overrides.audiences ?? {}),
            Layer.mock(CampaignRecipientService, overrides.recipients ?? {}),
            Layer.mock(CampaignSendService, overrides.sending ?? {}),
            Layer.mock(CampaignSendStatusService, {}),
            automationServiceStubs()
          )
        )
      )
    ),
    Effect.runPromise
  );

const failureOf = <A, E>(
  operation: (
    operations: CampaignOperations["Service"]
  ) => Effect.Effect<A, E, CurrentAdministrator | OperationRequestLedger>,
  overrides?: Overrides
) =>
  runOperations(
    (operations) => operation(operations).pipe(Effect.flip),
    overrides
  );

describe("CampaignOperations.invoke", () => {
  test("re-reads the administrator grant and refuses a revoked one before the handler runs", async () => {
    const calls: string[] = [];
    const error = await failureOf(
      (operations) => operations.invoke("getCampaign", { campaignId }),
      {
        isAdministrator: false,
        campaigns: {
          get: () =>
            Effect.sync(() => {
              calls.push("get");
              return campaignRow();
            }),
        },
      }
    );

    expect(error).toMatchObject({
      _tag: "OperationUnauthorized",
      code: "administrator-required",
    });
    expect(calls).toEqual([]);
  });

  test("refuses an unknown input key as invalid input before the handler runs", async () => {
    const calls: string[] = [];
    const invalidInput = { campaignId, unexpected: true };
    const error = await failureOf(
      (operations) => operations.invoke("getCampaign", invalidInput),
      {
        campaigns: {
          get: () =>
            Effect.sync(() => {
              calls.push("get");
              return campaignRow();
            }),
        },
      }
    );

    expect(error).toMatchObject({
      _tag: "OperationInputInvalid",
      code: "input-invalid",
      issues: [expect.objectContaining({ path: ["unexpected"] })],
    });
    expect(calls).toEqual([]);
  });

  test.each([
    [
      "a missing campaign",
      new CampaignNotFound({ campaignId }),
      "OperationNotFound",
      "campaign-not-found",
    ],
    [
      "a one-off operation on an automated campaign",
      new CampaignDeliveryMismatch({ campaignId, delivery: "automated" }),
      "OperationConflict",
      "campaign-delivery-mismatch",
    ],
    [
      "an invalid test recipient",
      new CampaignTestRecipientInvalid({ email: "not an email" }),
      "OperationInputInvalid",
      "test-recipient-invalid",
    ],
    [
      "Dotypos being unavailable",
      new CampaignRecipientResolutionError({
        source: "dotypos",
        cause: new Error("timeout"),
      }),
      "OperationUnavailable",
      "recipient-resolution-unavailable",
    ],
    [
      "an unexpected failure",
      new EffectDrizzleQueryError({
        query: "select 1",
        params: [],
        cause: new Error("connection reset"),
      }),
      "OperationUnavailable",
      "service-unavailable",
    ],
  ] as const)(
    "maps %s to its category and code, keeping the cause",
    async (_, cause, category, code) => {
      const audienceId = campaignAudienceIdSchema.make(
        "01990000-0000-7000-8000-000000000002"
      );
      const error =
        cause instanceof CampaignRecipientResolutionError
          ? await failureOf(
              (operations) =>
                operations.invoke("previewCampaignRecipients", { campaignId }),
              {
                campaigns: {
                  get: () => Effect.succeed(campaignRow({ audienceId })),
                },
                audiences: {
                  get: () =>
                    Effect.succeed({
                      id: audienceId,
                      title: "Everyone",
                      filter: everyoneFilter,
                      archivedAt: null,
                      createdAt,
                      updatedAt: createdAt,
                    }),
                },
                recipients: { resolve: () => Effect.fail(cause) },
              }
            )
          : await failureOf(
              (operations) =>
                operations.invoke("testSendCampaign", {
                  campaignId,
                  recipients: [],
                }),
              { sending: { testSend: () => Effect.fail(cause) } }
            );

      expect(error).toMatchObject({ _tag: category, code });
      expect(error.cause).toBe(cause);
    }
  );

  test("applies a ledger operation through the adapter's ledger, which may replay it", async () => {
    const stored = new Map<string, unknown>();
    const handled: string[] = [];
    const replayingLedger: OperationRequestLedger["Service"] = {
      applyOnce: (entry) => {
        const { requestId } = entry.input;
        if (!stored.has(requestId)) {
          return entry.apply.pipe(
            Effect.tap((result) =>
              Effect.sync(() => stored.set(requestId, result))
            )
          );
        }
        const result = stored.get(requestId);
        const isOutput = Schema.is(campaignOperations[entry.operation].output);
        if (!isOutput(result))
          throw new Error("Expected a stored operation output");
        return Effect.succeed(result);
      },
    };
    const requestId = CliMutationRequestId.make(crypto.randomUUID());
    const duplicate = (operations: CampaignOperations["Service"]) =>
      operations.invoke("duplicateCampaign", { campaignId, requestId });
    const overrides: Overrides = {
      ledger: replayingLedger,
      campaigns: {
        duplicate: () =>
          Effect.sync(() => {
            handled.push("duplicate");
            return campaignRow({ title: "Copy of October news" });
          }),
      },
    };

    const first = await runOperations(duplicate, overrides);
    const replayed = await runOperations(duplicate, overrides);

    expect(replayed).toEqual(first);
    expect(handled).toEqual(["duplicate"]);
  });

  test("runs a non-ledger operation without the ledger", async () => {
    const ledger: OperationRequestLedger["Service"] = {
      applyOnce: () => Effect.die("not expected"),
    };

    const detail = await runOperations(
      (operations) => operations.invoke("getCampaign", { campaignId }),
      {
        ledger,
        campaigns: { get: () => Effect.succeed(campaignRow()) },
      }
    );

    expect(detail).toMatchObject({ id: campaignId, delivery: "once" });
  });
});
