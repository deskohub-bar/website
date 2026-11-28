import "@/shared/testing/workspace-test-env";

import { beforeEach, describe, expect, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Exit, Layer } from "effect";
import { mockAdministrationActionRequest } from "@/shared/testing/workspace-action-request.test-utils";
import type { ICampaignService } from "../backend/campaign.service";
import type { ICampaignAudienceService } from "../backend/campaign-audience.service";
import { automationServiceStubs } from "../backend/campaign-operations.test-utils";
import type { ICampaignSendService } from "../backend/campaign-send.service";
import type { CampaignBodyNode } from "../body/campaign-body-document";
import {
  type CampaignAudienceId,
  type CampaignId,
  campaignAudienceIdSchema,
  campaignIdSchema,
} from "../campaign-identifiers";
import { CampaignConfirmationRejected, CampaignReadOnly } from "../errors";

const { access } = await mockAdministrationActionRequest({
  administrator: "campaign-operations-actions",
});
const revalidatePath = mock((_path: string) => undefined);

mock.module("next/cache", () => ({
  revalidatePath,
  revalidateTag: () => undefined,
}));

const operationsModule = await import("../backend/campaign-operations.service");
const grantsModule = await import(
  "@/features/administrators/backend/account-role-grants.service"
);
const audienceModule = await import("../backend/campaign-audience.service");
const campaignModule = await import("../backend/campaign.service");
const recipientModule = await import("../backend/campaign-recipient.service");
const sendModule = await import("../backend/campaign-send.service");
const sendStatusModule = await import(
  "../backend/campaign-send-status.service"
);

const campaignId = campaignIdSchema.make("synthetic-campaign");
const audienceId = campaignAudienceIdSchema.make("synthetic-audience");
const syntheticInstant = Temporal.Instant.from("2026-10-01T08:00:00Z");
const archivedAudience = {
  id: audienceId,
  title: "Synthetic audience",
  filter: { _tag: "Group", operator: "and", filters: [] },
  archivedAt: syntheticInstant,
  createdAt: syntheticInstant,
  updatedAt: syntheticInstant,
} satisfies Effect.Success<ReturnType<ICampaignAudienceService["archive"]>>;
const archiveAudience = mock(
  (
    _audienceId: CampaignAudienceId
  ): ReturnType<ICampaignAudienceService["archive"]> =>
    Effect.succeed(archivedAudience)
);

let holdsGrant = true;
let sendResult: ReturnType<ICampaignSendService["send"]> = Effect.die(
  "Unexpected campaign send"
);
let deleteResult: ReturnType<ICampaignService["delete"]> = Effect.void;
const deleteCampaign = mock((_campaignId: CampaignId) => deleteResult);
const send = mock(
  (_input: Parameters<ICampaignSendService["send"]>[0]) => sendResult
);

const stubbedDomain = Layer.mergeAll(
  Layer.mock(grantsModule.AccountRoleGrants, {
    has: () => Effect.succeed(holdsGrant),
  }),
  Layer.mock(audienceModule.CampaignAudienceService, {
    archive: archiveAudience,
  }),
  Layer.mock(campaignModule.CampaignService, { delete: deleteCampaign }),
  Layer.mock(recipientModule.CampaignRecipientService, {}),
  Layer.mock(sendModule.CampaignSendService, { send }),
  Layer.mock(sendStatusModule.CampaignSendStatusService, {}),
  automationServiceStubs()
);

// The real port over stubbed domain services.
class StubbedCampaignOperations extends operationsModule.CampaignOperations {
  static override Live = operationsModule.CampaignOperations.Default.pipe(
    Layer.provide(stubbedDomain)
  );
}

mock.module("../backend/campaign-operations.service", () => ({
  ...operationsModule,
  CampaignOperations: StubbedCampaignOperations,
}));

const { runCampaignOperation } = await import("./campaign-operations.actions");
const { campaignOperationAction } = await import(
  "./campaign-operation-action.server"
);
const { CurrentAdministrator } = await import(
  "@/features/administrators/backend/current-administrator"
);
const { OperationRequestLedger } = await import(
  "../backend/operation-request-ledger.service"
);
const { toCampaignPreviewInput } = await import(
  "./composer/campaign-composer-fields"
);

beforeEach(() => {
  access.set("administrator");
  holdsGrant = true;
  sendResult = Effect.die("Unexpected campaign send");
  deleteResult = Effect.void;
  deleteCampaign.mockClear();
  send.mockClear();
  revalidatePath.mockClear();
});

describe("runCampaignOperation", () => {
  test("returns a query's output without revalidating", async () => {
    const result = await runCampaignOperation({
      operation: "listCampaignTemplates",
      input: {},
    });

    expect(result?.data).toEqual({
      _tag: "Success",
      output: [expect.objectContaining({ key: "workspace" })],
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("revalidates the campaign pages after a mutation succeeds", async () => {
    const result = await runCampaignOperation({
      operation: "deleteCampaign",
      input: { campaignId },
    });

    expect(result?.data).toEqual({
      _tag: "Success",
      output: { id: campaignId },
    });
    expect(deleteCampaign).toHaveBeenCalledWith(campaignId);
    expect(revalidatePath.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        "/en-US/admin/email-campaigns",
        "/cs-CZ/admin/email-campaigns",
        "/en-US/admin/email-audiences",
        `/en-US/admin/email-campaigns/${campaignId}`,
        `/cs-CZ/admin/email-campaigns/${campaignId}`,
      ])
    );
  });

  test("revalidates an audience's page after an audience mutation", async () => {
    const result = await runCampaignOperation({
      operation: "archiveCampaignAudience",
      input: { audienceId },
    });

    expect(result?.data).toMatchObject({
      _tag: "Success",
      output: { id: audienceId, archivedAt: syntheticInstant.toString() },
    });
    expect(revalidatePath.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        "/en-US/admin/email-audiences",
        `/en-US/admin/email-audiences/${audienceId}`,
        `/cs-CZ/admin/email-audiences/${audienceId}`,
      ])
    );
  });

  test("returns a domain failure as data with its category and code", async () => {
    sendResult = Effect.fail(
      new CampaignConfirmationRejected({ campaignId, reason: "expired" })
    );

    const result = await runCampaignOperation({
      operation: "sendCampaign",
      input: { campaignId, confirmationCode: "ABCD-1234" },
    });

    expect(result?.data).toEqual({
      _tag: "Failure",
      category: "OperationConflict",
      code: "confirmation-expired",
      message: expect.any(String),
    });
    expect(result?.serverError).toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("doesn't revalidate after a failed mutation", async () => {
    deleteResult = Effect.fail(
      new CampaignReadOnly({ campaignId, status: "sent" })
    );

    const result = await runCampaignOperation({
      operation: "deleteCampaign",
      input: { campaignId },
    });

    expect(result?.data).toMatchObject({
      _tag: "Failure",
      category: "OperationConflict",
      code: "campaign-read-only",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test.each(["signed-out", "not-administrator", "unavailable"] as const)(
    "refuses a %s caller as data",
    async (caller) => {
      access.set(caller);

      const result = await runCampaignOperation({
        operation: "deleteCampaign",
        input: { campaignId },
      });

      expect(result?.data).toMatchObject({
        _tag: "Failure",
        category: "OperationUnauthorized",
        code: "administrator-required",
      });
      expect(result?.serverError).toBeUndefined();
      expect(deleteCampaign).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    }
  );

  test("refuses an administrator whose grant was revoked", async () => {
    holdsGrant = false;

    const result = await runCampaignOperation({
      operation: "deleteCampaign",
      input: { campaignId },
    });

    expect(result?.data).toMatchObject({
      _tag: "Failure",
      category: "OperationUnauthorized",
      code: "administrator-required",
    });
    expect(deleteCampaign).not.toHaveBeenCalled();
  });

  test("returns input the port rejects as an invalid-input failure", async () => {
    const result = await campaignOperationAction({
      operation: "deleteCampaign",
      input: { campaignId, unexpected: true },
    });

    expect(result?.data).toMatchObject({
      _tag: "Failure",
      category: "OperationInputInvalid",
      code: "input-invalid",
    });
    expect(deleteCampaign).not.toHaveBeenCalled();
  });

  test("refuses a campaign ID that isn't text before the handler runs", async () => {
    // A client can send any payload; this one arrives with a numeric ID.
    const result = await campaignOperationAction({
      operation: "deleteCampaign",
      input: { campaignId: 42 },
    });

    expect(result?.data).toMatchObject({
      _tag: "Failure",
      category: "OperationInputInvalid",
      code: "input-invalid",
    });
    expect(deleteCampaign).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("refuses input without its operation's shape before checking a revoked grant", async () => {
    holdsGrant = false;
    const input = { campaignId, retiredField: true };

    const result = await runCampaignOperation({
      operation: "deleteCampaign",
      input,
    });

    expect(result?.data).toMatchObject({
      _tag: "Failure",
      category: "OperationInputInvalid",
      code: "input-invalid",
    });
    expect(deleteCampaign).not.toHaveBeenCalled();
  });

  test("reports an output its operation's schema rejects as unavailable", async () => {
    archiveAudience.mockImplementationOnce(() =>
      Effect.succeed({
        ...archivedAudience,
        filter: {
          _tag: "Condition",
          attribute: "reservationCount",
          params: { dateBasis: "visit", period: { _tag: "AnyTime" } },
          operator: "eq",
          value: -1,
        },
      })
    );

    const result = await runCampaignOperation({
      operation: "archiveCampaignAudience",
      input: { audienceId },
    });

    expect(result?.data).toMatchObject({
      _tag: "Failure",
      category: "OperationUnavailable",
      code: "output-invalid",
    });
  });

  test("rejects an operation the registry doesn't know", async () => {
    const result = await campaignOperationAction({
      operation: "dropAllCampaigns",
      input: {},
    });

    expect(result?.data).toBeUndefined();
    expect(result?.validationErrors).toBeDefined();
  });
});

describe("composer preview", () => {
  /** The port itself, without the Admin UI bridge in between. */
  const invokePort = (input: ReturnType<typeof toCampaignPreviewInput>) =>
    Effect.runPromiseExit(
      operationsModule.CampaignOperations.pipe(
        Effect.flatMap((operations) =>
          operations.invoke("previewCampaignTemplate", input)
        ),
        Effect.provideService(CurrentAdministrator, access.administrator),
        Effect.provide(
          Layer.mergeAll(
            OperationRequestLedger.unscoped,
            StubbedCampaignOperations.Live
          )
        )
      )
    );

  const link = (href: string | null): CampaignBodyNode => ({
    type: "paragraph",
    content: [
      { type: "text", text: "Visit " },
      {
        type: "text",
        text: "our site",
        marks: [{ type: "link", attrs: { href } }],
      },
    ],
  });

  const previewInput = (...content: readonly CampaignBodyNode[]) =>
    toCampaignPreviewInput({
      templateKey: "workspace",
      purpose: "operational",
      locale: "en-US",
      fields: {
        subject: " Synthetic news ",
        preheader: "Synthetic preheader",
        body: { type: "doc", content },
        operationalReason: "",
      },
    });

  const strict = (input: ReturnType<typeof previewInput>) => {
    assert(input.preview._tag === "UnfinishedContent");
    return {
      ...input,
      preview: { ...input.preview, _tag: "Content" as const },
    };
  };

  test("renders unfinished buttons and links as the port does", async () => {
    const input = previewInput(
      link(""),
      link("htt"),
      { type: "ctaButton", attrs: { label: "", href: null } },
      { type: "ctaButton", attrs: { label: "Book", href: "javascript:x" } }
    );

    const direct = await invokePort(input);
    const bridged = await runCampaignOperation({
      operation: "previewCampaignTemplate",
      input,
    });

    expect(Exit.isSuccess(direct)).toBe(true);
    if (!Exit.isSuccess(direct)) return;
    expect(direct.value.subject).toBe("Synthetic news");
    expect(direct.value.html).toContain("our site");
    expect(direct.value.html).toContain("Book");
    expect(bridged?.data).toEqual({ _tag: "Success", output: direct.value });
  });

  test("refuses the same unfinished content as unsaved content", async () => {
    const input = strict(
      previewInput({ type: "ctaButton", attrs: { label: "", href: null } })
    );

    const direct = await invokePort(input);
    const bridged = await runCampaignOperation({
      operation: "previewCampaignTemplate",
      input,
    });

    expect(Exit.isFailure(direct)).toBe(true);
    expect(bridged?.data).toMatchObject({
      _tag: "Failure",
      category: "OperationInputInvalid",
      code: "content-document-invalid",
    });
  });

  test("renders finished content the same in either mode", async () => {
    const input = previewInput(link("https://workspace.deskohub.cz"), {
      type: "ctaButton",
      attrs: { label: "Book", href: "https://workspace.deskohub.cz" },
    });

    const unfinished = await runCampaignOperation({
      operation: "previewCampaignTemplate",
      input,
    });
    const finished = await runCampaignOperation({
      operation: "previewCampaignTemplate",
      input: strict(input),
    });

    expect(unfinished?.data?._tag).toBe("Success");
    expect(unfinished?.data).toEqual(finished?.data);
  });
});
