import "@/shared/testing/workspace-test-env";

import { afterAll, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DotyposCloudIdSchema,
  DotyposCustomerIdSchema,
} from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { makeInMemoryDotypos } from "@deskohub/dotypos/testing";
import {
  EmailConfigTag,
  EmailDeliveryIdSchema,
  type EmailMessage,
  type EmailProvider,
  EmailProviders,
  EmailServiceError,
  EmailServiceTag,
  NetworkError,
} from "@deskohub/email";
import { makePostHogEmailProvider } from "@deskohub/email-posthog";
import {
  makeResendEmailProvider,
  resendRequestTimeouts,
} from "@deskohub/email-resend";
import { testEmailAddress } from "@deskohub/test-email";
import {
  CliMutationRequestId,
  EmailDraft,
} from "@deskohub/workspace-admin-api";
import { NodeCrypto } from "@effect/platform-node";
import {
  Cause,
  Effect,
  Exit,
  Layer,
  Logger,
  Redacted,
  References,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { WorkspaceDatabase } from "@/db/database.service";
import {
  customerMarketingConsents,
  discountProductTargets,
  discounts,
} from "@/db/schema";
import { customerAccountIdSchema } from "@/features/account/customer-account";
import { AccountRoleGrants } from "@/features/administrators/backend/account-role-grants.service";
import { CurrentAdministrator } from "@/features/administrators/backend/current-administrator";
import { canonicalPromotionCodeSchema } from "@/features/discounts/contracts";
import { DiscountDefinitionRepository } from "@/features/discounts/discount-definition.repository";
import { storedDiscountIdSchema } from "@/features/discounts/persistence-contracts";
import { PromotionCodeRepository } from "@/features/discounts/promotion-code.repository";
import { PromotionCodeProvider } from "@/features/discounts/promotion-code-provider.service";
import { EmailPersistence } from "@/features/emails/backend";
import { writeEmailDraft } from "@/features/emails/backend/write-email-draft";
import {
  CustomerValues,
  CustomerValueUnavailable,
} from "@/features/emails/values/customer";
import { EmailPreparationRetry } from "@/features/emails/values/preparation";
import type { Locale } from "@/features/i18n";
import { analyticsConsentLedgerOf } from "@/features/legal/backend/analytics-consent-ledger.test-utils";
import { stubFetch } from "@/shared/testing/fetch-stub.test-utils";
import { workspaceFixtures } from "@/shared/testing/workspace-fixtures.test-utils";
import { createWorkspacePostgresSuiteDatabase } from "@/shared/testing/workspace-postgres-test-database.test-utils";
import {
  campaignDeliveryBatchIdempotencyKey,
  campaignDeliveryPayloadHash,
} from "../campaign-delivery-batches";
import { CampaignService } from "./campaign.service";
import { CampaignAudienceService } from "./campaign-audience.service";
import { CampaignConfirmationCodeService } from "./campaign-confirmation-code.service";
import { campaignDeliveryTestLayer } from "./campaign-delivery.test-utils";
import { CampaignEmailConfig } from "./campaign-email.config";
import { CampaignOperations } from "./campaign-operations.service";
import { automationServiceStubs } from "./campaign-operations.test-utils";
import { listCampaignEmailPublications } from "./campaign-published-email";
import { CampaignRecipientService } from "./campaign-recipient.service";
import { CampaignSendService } from "./campaign-send.service";
import {
  type CampaignDeliveryAttempt,
  CampaignSendQueueService,
} from "./campaign-send-queue.service";
import { processCampaignSendMessage } from "./campaign-send-queue-consumer";
import { CampaignSendStatusService } from "./campaign-send-status.service";
import { everyoneFilter } from "./email-campaigns.test-utils";
import { OnceCampaignLifecycle } from "./once-campaign-lifecycle";
import { OperationRequestLedger } from "./operation-request-ledger.service";

const database = await createWorkspacePostgresSuiteDatabase("campaign_offers");
afterAll(async () => database?.close());

const invite =
  "https://workspace.deskohub.cz/en-US/reservation/cowork?entryTier=open-space";
const sender = testEmailAddress("campaigns");
const adminInbox = testEmailAddress("admin");
const decodeResendBatch = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        to: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        html: Schema.String,
      })
    )
  )
);

const bookingCode = (message: Pick<EmailMessage, "html"> | undefined) => {
  const href = message?.html?.match(
    /href="(https:\/\/workspace\.deskohub\.cz\/en-US\/reservation\/cowork\?[^"]+)"/
  )?.[1];
  return URL.parse(href?.replaceAll("&amp;", "&") ?? "")?.searchParams.get(
    "discountCode"
  );
};

describe.skipIf(!database)("one-off campaigns with a published offer", () => {
  if (!database) return;
  const { db, pool } = database;
  const promotionCodes = PromotionCodeProvider.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        DiscountDefinitionRepository.Default,
        PromotionCodeRepository.Default
      )
    ),
    Layer.provide(database.layer)
  );
  const validatesAtCheckout = (
    code: string,
    customer: Parameters<typeof DotyposCustomerIdSchema.make>[0],
    at: Temporal.Instant
  ) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* TestClock.setTime(at.epochMilliseconds);
        const provider = yield* PromotionCodeProvider;
        return yield* provider.revalidate({
          discountableSubtotal: { value: 10_000, exponent: 2, currency: "CZK" },
          dotyposCustomerId: DotyposCustomerIdSchema.make(customer),
          firstServiceDate: at
            .toZonedDateTimeISO("Europe/Prague")
            .toPlainDate()
            .toString(),
          locale: "en-US",
          product: { kind: "cowork", tier: "basic" },
          submittedCode: canonicalPromotionCodeSchema.make(code),
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(promotionCodes, TestClock.layer(), Logger.layer([]))
        )
      )
    );
  const setup = async (
    tag: string,
    {
      includeCustomerValue = false,
      checkLocales = false,
      includeAnalytics = false,
      marketingProviders,
    }: {
      includeCustomerValue?: boolean;
      checkLocales?: boolean;
      includeAnalytics?: boolean;
      /** Delivers through the real email service over these providers. */
      marketingProviders?: readonly EmailProvider[];
    } = {}
  ) => {
    const now = Temporal.Now.instant();
    const recipient = (name: string, locale: Locale = "en-US") => ({
      dotyposCustomerId: DotyposCustomerIdSchema.make(`${tag}-${name}`),
      email: testEmailAddress(`${tag}-${name}`),
      locale,
    });
    const recipients = [
      recipient("first"),
      recipient("second"),
      recipient("withdrawn"),
      recipient("untranslated", "hi-IN"),
    ] as const;
    const dotypos = makeInMemoryDotypos({
      customers: recipients.map(({ dotyposCustomerId, email }) => ({
        id: dotyposCustomerId,
        email,
        _cloudId: DotyposCloudIdSchema.make("test"),
        display: true,
        flags: "0",
        points: "0",
        deleted: false,
      })),
    });
    await Effect.runPromise(
      db.insert(customerMarketingConsents).values(
        recipients.map(({ dotyposCustomerId, locale }) => ({
          dotyposCustomerId,
          documentHash: "synthetic",
          locale,
          grantedAt: now,
          withdrawnAt: null,
        }))
      )
    );
    const testMessages: EmailMessage[] = [];
    const analyticsAccounts = includeAnalytics
      ? await Effect.runPromise(
          Effect.forEach(recipients.slice(0, 2), ({ dotyposCustomerId }) =>
            workspaceFixtures(db).customerAccount({
              linkedCustomer: dotyposCustomerId,
            })
          )
        )
      : [];
    const analyticsGrants = new Set(analyticsAccounts);
    const requests: {
      readonly key: string;
      readonly replay: boolean;
      readonly messages: readonly EmailMessage[];
    }[] = [];
    let attempt: CampaignDeliveryAttempt | undefined;
    let answer: "accept" | "interrupt" | "refuse" | "opaque-refusal" = "accept";
    let customerValuesAvailable = true;
    let beforeProviderRequest: (() => Promise<unknown>) | undefined;
    let afterFirstRecipientRequest: (() => Promise<unknown>) | undefined;
    let interruptedBeforeAdmission = false;
    let sendPaused:
      | {
          readonly called: PromiseWithResolvers<void>;
          readonly resume: PromiseWithResolvers<void>;
        }
      | undefined;
    const acceptance = (id: string) => ({
      id: EmailDeliveryIdSchema.make(`${tag}-${id}`),
      status: "sent" as const,
      provider: "test",
      timestamp: new Date(),
    });
    const email = Layer.succeed(EmailServiceTag, {
      send: (message) =>
        Effect.sync(() => {
          testMessages.push(message);
          return acceptance("synthetic-test");
        }),
      sendBatch: (messages, options) =>
        Effect.gen(function* () {
          if (interruptedBeforeAdmission) {
            interruptedBeforeAdmission = false;
            return yield* new NetworkError({
              message: "Synthetic interruption before admission",
            });
          }
          const before = beforeProviderRequest;
          beforeProviderRequest = undefined;
          if (before) yield* Effect.promise(before);
          const afterFirst = afterFirstRecipientRequest;
          afterFirstRecipientRequest = undefined;
          if (afterFirst && options.beforeRequest) {
            const admit = options.beforeRequest;
            return yield* Effect.forEach(messages, (message, index) =>
              admit(`synthetic-recipient-${index}`, [index]).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    requests.push({
                      key: options.idempotencyKey,
                      messages: [message],
                      replay: options.replay ?? false,
                    });
                  })
                ),
                Effect.andThen(
                  index === 0 ? Effect.promise(afterFirst) : Effect.void
                ),
                Effect.as(acceptance(`synthetic-${index}`)),
                Effect.catch((error) =>
                  Effect.succeed({
                    status: "failed" as const,
                    provider: "test",
                    timestamp: new Date(),
                    error,
                  })
                )
              )
            );
          }
          if (options.beforeRequest)
            yield* options.beforeRequest(
              "synthetic-provider-fingerprint",
              messages.map((_, index) => index)
            );
          requests.push({
            key: options.idempotencyKey,
            messages,
            replay: options.replay ?? false,
          });
          if (sendPaused) {
            const { called, resume } = sendPaused;
            called.resolve();
            return yield* Effect.promise(() => resume.promise).pipe(
              Effect.as(
                messages.map((_, index) => acceptance(`synthetic-${index}`))
              )
            );
          }
          if (answer === "interrupt")
            return yield* Effect.fail(
              new NetworkError({ message: "Synthetic interruption" })
            );
          if (answer === "refuse")
            return yield* Effect.fail(
              new EmailServiceError("Synthetic refusal", undefined, "test", {
                definitivelyUnsent: true,
                code: "synthetic-refusal",
              })
            );
          if (answer === "opaque-refusal")
            return messages.map(() => ({
              status: "failed" as const,
              provider: "test",
              timestamp: new Date(),
              error: new EmailServiceError(
                "Synthetic final fallback refusal",
                undefined,
                "test",
                {
                  definitivelyUnsent: true,
                  code: "synthetic-refusal",
                }
              ),
            }));
          return messages.map((_, index) => acceptance(`synthetic-${index}`));
        }),
    });
    const config = Layer.succeed(CampaignEmailConfig, {
      deploymentEnvironment: "preview",
      from: { email: sender },
      replyTo: { email: sender },
      adminInbox,
    });
    const sending = Layer.mergeAll(
      CampaignService.Default,
      CampaignAudienceService.Default,
      EmailPersistence.Default,
      CampaignSendService.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            CampaignService.Default,
            CampaignAudienceService.Default,
            CampaignConfirmationCodeService.Default.pipe(
              Layer.provide(NodeCrypto.layer)
            ),
            Layer.mock(CampaignRecipientService, {
              resolve: ({ purpose }) =>
                Effect.sync(() => {
                  expect(purpose).toBe("marketing");
                  return { recipients, exclusions: [], duplicates: [] };
                }),
            }),
            config,
            email,
            Layer.succeed(CampaignSendQueueService, {
              enqueue: (queued) =>
                Effect.sync(() => {
                  attempt = queued;
                }),
            })
          )
        )
      )
    ).pipe(
      Layer.provideMerge(Logger.layer([])),
      Layer.provideMerge(database.layer)
    );
    const operations = CampaignOperations.Default.pipe(
      Layer.provide(
        Layer.mergeAll(
          sending,
          Layer.mock(AccountRoleGrants, { has: () => Effect.succeed(true) }),
          Layer.mock(CampaignRecipientService, {}),
          Layer.mock(CampaignSendStatusService, {}),
          automationServiceStubs()
        )
      )
    );
    const runOperations = <A, E>(
      use: (
        port: CampaignOperations["Service"]
      ) => Effect.Effect<A, E, CurrentAdministrator | OperationRequestLedger>
    ) =>
      Effect.runPromise(
        CampaignOperations.pipe(
          Effect.flatMap(use),
          Effect.provide(operations),
          Effect.provide(OperationRequestLedger.unscoped),
          Effect.provideService(CurrentAdministrator, {
            accountId: customerAccountIdSchema.make("synthetic-administrator"),
            email: adminInbox,
          })
        )
      );
    const requestId = () => CliMutationRequestId.make(crypto.randomUUID());
    const checkCampaignLocales = (
      campaignId: Parameters<CampaignService["Service"]["get"]>[0],
      locales: readonly Locale[]
    ) =>
      runOperations((port) =>
        Effect.gen(function* () {
          const detail = yield* port.invoke("getCampaign", { campaignId });
          const editor = yield* port.invoke("getCampaignEditorContent", {
            campaignId,
          });
          const list = yield* port.invoke("listCampaigns", {});
          expect(detail.locales).toEqual(locales);
          expect(editor.locales).toEqual(locales);
          expect(list.find(({ id }) => id === campaignId)?.locales).toEqual(
            locales
          );
        })
      );
    const logged: string[] = [];
    const deliveryEmail = marketingProviders
      ? EmailServiceTag.Default.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EmailProviders, {
                transactional: [],
                marketing: marketingProviders,
                marketingCategories: new Set(["email-campaign"]),
              }),
              Layer.succeed(EmailConfigTag, { defaultFrom: { email: sender } })
            )
          )
        )
      : email;
    const delivery = campaignDeliveryTestLayer(
      Layer.mergeAll(
        config,
        deliveryEmail,
        DotyposServiceMock({
          getCustomersByIds: dotypos.service.getCustomersByIds,
        })
      ),
      analyticsConsentLedgerOf((accountId) =>
        analyticsGrants.has(accountId) ? "grant" : "withdraw"
      ),
      Layer.succeed(CustomerValues, {
        resolve: () =>
          customerValuesAvailable
            ? Effect.succeed("Sample Customer")
            : Effect.fail(new CustomerValueUnavailable({ source: "profile" })),
      })
    ).pipe(
      Layer.provideMerge(
        Logger.layer([
          Logger.make(({ message, cause, fiber }) => {
            logged.push(
              JSON.stringify({
                message,
                annotations: fiber.getRef(References.CurrentLogAnnotations),
                cause: Cause.pretty(cause),
              })
            );
          }),
        ])
      ),
      Layer.provide(database.layer)
    );
    const discountId = storedDiscountIdSchema.make(crypto.randomUUID());
    await Effect.runPromise(
      db.insert(discounts).values({
        id: discountId,
        labels: { "cs-CZ": "Sleva na coworking", "en-US": "Cowork offer" },
        percentageBasisPoints: 2500,
      })
    );
    await Effect.runPromise(
      db.insert(discountProductTargets).values({
        discountId,
        productTarget: { kind: "cowork" },
      })
    );
    const { campaign, draft } = await Effect.runPromise(
      Effect.gen(function* () {
        const emails = yield* EmailPersistence;
        const reusable = yield* emails.create({
          title: "Synthetic cowork offer",
          draft: { purpose: "marketing", templateKey: "workspace" },
        });
        const draft = Schema.decodeUnknownSync(EmailDraft)({
          purpose: "marketing",
          templateKey: "workspace",
          structure: [
            {
              _tag: "Offer",
              id: "offer",
              value: "offer",
              labelKey: "book",
              href: invite,
              prefillDiscountCode: true,
            },
          ],
          translations: {
            "cs-CZ": {
              subject: [{ _tag: "Text", text: "Ukázková nabídka coworkingu" }],
              texts: {
                book: [{ _tag: "Text", text: "Rezervovat coworking" }],
              },
            },
            "en-US": {
              subject: [{ _tag: "Text", text: "Synthetic cowork offer" }],
              ...(includeCustomerValue && {
                preheader: [{ _tag: "Value", name: "customer" }],
              }),
              texts: { book: [{ _tag: "Text", text: "Book coworking" }] },
            },
          },
          values: [
            {
              name: "offer",
              source: {
                kind: "discount",
                discountId,
                validDays: 30,
                maxUses: 1,
                maxUsesPerCustomer: 1,
              },
            },
            ...(includeCustomerValue
              ? [
                  {
                    name: "customer",
                    source: {
                      kind: "customer",
                      path: ["profile", "customer", "displayName"],
                    },
                  },
                ]
              : []),
          ],
        });
        const saved = yield* writeEmailDraft({
          emailId: reusable.id,
          draft,
          publish: false,
        });
        expect(saved.publishedVersion).toBeNull();
        const beforePublish = yield* listCampaignEmailPublications(db);
        expect(
          beforePublish.some(({ emailId }) => emailId === reusable.id)
        ).toBe(false);
        const published = yield* writeEmailDraft({
          emailId: reusable.id,
          draft,
          publish: true,
        });
        expect(published.publishedVersion).toBe(1);
        const choices = yield* listCampaignEmailPublications(db);
        expect(choices.some(({ emailId }) => emailId === reusable.id)).toBe(
          true
        );
        const audiences = yield* CampaignAudienceService;
        const audience = yield* audiences.create({
          title: "Synthetic audience",
          filter: everyoneFilter,
        });
        const campaign = {
          title: "Synthetic campaign",
          emailId: reusable.id,
          purpose: "marketing" as const,
          templateKey: "workspace" as const,
          audienceId: audience.id,
          content: {},
        };
        if (!checkLocales)
          return {
            campaign: yield* (yield* CampaignService).create(campaign),
            draft,
          };
        const created = yield* Effect.promise(() =>
          runOperations((port) =>
            port.invoke("createCampaign", { requestId: requestId(), campaign })
          )
        );
        expect(created.locales).toEqual(["en-US", "cs-CZ"]);
        return { campaign: created, draft };
      }).pipe(Effect.provide(sending))
    );
    if (checkLocales)
      await checkCampaignLocales(campaign.id, ["en-US", "cs-CZ"]);
    await Effect.runPromise(
      Effect.flatMap(CampaignSendService, (sends) =>
        sends.testSend({ campaignId: campaign.id, extraRecipients: [] })
      ).pipe(Effect.provide(sending))
    );
    const sample = testMessages.find(
      ({ subject }) => subject === "[TEST] Synthetic cowork offer"
    );
    expect(sample?.subject).toBe("[TEST] Synthetic cowork offer");
    expect(bookingCode(sample)).toBe("SAMPLE CODE");
    const issuedBefore = await pool.query(
      "select 1 from discount_codes where discount_id = $1",
      [discountId]
    );
    expect(issuedBefore.rowCount).toBe(0);
    const confirmationCode = sample?.text?.match(/: ([A-Z2-9]{8})\b/)?.[1];
    if (!confirmationCode)
      throw new Error("The test message did not carry a confirmation code");
    const { sendId } = await Effect.runPromise(
      Effect.flatMap(CampaignSendService, (sends) =>
        sends.send({ campaignId: campaign.id, confirmationCode })
      ).pipe(Effect.provide(sending))
    );
    await pool.query(
      "update customer_marketing_consents set withdrawn_at = now() where dotypos_customer_id = $1",
      [recipients[2].dotyposCustomerId]
    );
    const issuanceIdentity = async () => {
      const { rows } = await pool.query(
        "select i.code, i.expires_at from email_discount_issuances i join email_preparations p on p.id = i.preparation_id where p.send_id = $1 order by p.dotypos_customer_id",
        [sendId]
      );
      return JSON.stringify(rows);
    };
    let originalIssuance: string | undefined;
    return {
      recipients,
      sendId,
      requests,
      logged,
      answerWith: (next: typeof answer) => {
        answer = next;
      },
      setCustomerValuesAvailable: (available: boolean) => {
        customerValuesAvailable = available;
      },
      moveFirstRecipient: () => {
        const id = recipients[0].dotyposCustomerId;
        const customer = dotypos.customers.get(id);
        if (!customer) throw new Error("Missing synthetic customer");
        dotypos.customers.set(id, {
          ...customer,
          email: testEmailAddress(`${tag}-moved`),
        });
      },
      withdrawFirstAnalyticsGrant: () => {
        const [id] = analyticsAccounts;
        if (!id) throw new Error("Missing synthetic analytics account");
        analyticsGrants.delete(id);
      },
      changeEligibilityBeforeRequest: (change: "withdraw" | "disable") => {
        beforeProviderRequest = async () => {
          originalIssuance = await issuanceIdentity();
          await pool.query(
            change === "withdraw"
              ? "update customer_marketing_consents set withdrawn_at = now() where dotypos_customer_id = $1"
              : "update discount_codes set enabled = false where id in (select code_id from discount_code_customers where dotypos_customer_id = $1)",
            [recipients[0].dotyposCustomerId]
          );
        };
      },
      disableFirstCodeAfterRequest: () => {
        afterFirstRecipientRequest = () =>
          pool.query(
            "update discount_codes set enabled = false where id in (select code_id from discount_code_customers where dotypos_customer_id = $1)",
            [recipients[0].dotyposCustomerId]
          );
      },
      interruptBeforeAdmission: () => {
        interruptedBeforeAdmission = true;
      },
      hasOriginalIssuance: async () =>
        (await issuanceIdentity()) === originalIssuance,
      pauseDelivery: () => {
        const pause = {
          called: Promise.withResolvers<void>(),
          resume: Promise.withResolvers<void>(),
        };
        sendPaused = pause;
        return {
          called: pause.called.promise,
          resume: () => pause.resume.resolve(),
        };
      },
      deliver: () => {
        if (!attempt) throw new Error("No campaign delivery was queued");
        return Effect.runPromiseExit(
          processCampaignSendMessage(attempt).pipe(
            Effect.provide(delivery),
            Effect.provideService(EmailPreparationRetry, {
              retries: 0,
              baseDelay: 0,
            })
          )
        );
      },
      retry: (includeUnconfirmed = true) =>
        Effect.runPromiseExit(
          Effect.flatMap(CampaignSendService, (sends) =>
            sends.retryUndelivered({
              campaignId: campaign.id,
              includeUnconfirmed,
            })
          ).pipe(Effect.provide(sending))
        ),
      abandon: () =>
        Effect.runPromise(
          Effect.flatMap(WorkspaceDatabase, ({ transaction }) =>
            transaction(
              OnceCampaignLifecycle.abandon({
                campaignId: campaign.id,
                sendId,
                deliveryAttempt: 1,
                now: Temporal.Now.instant(),
              })
            )
          ).pipe(Effect.provide(Layer.merge(database.layer, Logger.layer([]))))
        ),
      staleWrite: () =>
        pool
          .query("update email_campaigns set content = $2 where id = $1", [
            campaign.id,
            { "en-US": { subject: "Old inline content" } },
          ])
          .then(
            () => undefined,
            (cause: { code?: string }) => cause.code
          ),
      publishLater: () =>
        pool.query(
          `insert into email_versions (email_id, version_number, document, required_value_names)
           select email_id, version_number + 1,
             jsonb_set(document, '{translations,en-US,subject,0,text}', to_jsonb('Later publication'::text)),
             required_value_names from email_versions where email_id = $1`,
          [campaign.emailId]
        ),
      checkFrozenLocales: async () => {
        const duplicate = () =>
          runOperations((port) =>
            port.invoke("duplicateCampaign", {
              requestId: requestId(),
              campaignId: campaign.id,
            })
          );
        const existingDraft = await duplicate();
        expect(existingDraft.locales).toEqual(["en-US", "cs-CZ"]);
        if (!campaign.emailId) throw new Error("Missing linked email");
        const czech = draft.translations?.["cs-CZ"];
        assert(czech, "Expected the Czech draft translation");
        await Effect.runPromise(
          writeEmailDraft({
            emailId: campaign.emailId,
            draft: {
              ...draft,
              translations: { "cs-CZ": czech },
            },
            publish: true,
          }).pipe(Effect.provide(sending))
        );
        await checkCampaignLocales(campaign.id, ["en-US", "cs-CZ"]);
        await checkCampaignLocales(existingDraft.id, ["cs-CZ"]);
        const duplicated = await duplicate();
        expect(duplicated.locales).toEqual(["cs-CZ"]);
        await checkCampaignLocales(duplicated.id, ["cs-CZ"]);
        const updated = await runOperations((port) =>
          port.invoke("updateCampaign", {
            campaignId: duplicated.id,
            title: "Updated offer",
          })
        );
        expect(updated.locales).toEqual(["cs-CZ"]);
      },
      issued: () =>
        pool.query<{
          enabled: boolean;
          restricted: boolean;
          valid_window: boolean;
        }>(
          `select c.enabled, c.max_uses = 1 and c.max_uses_per_customer = 1 and exists (
           select 1 from discount_code_customers a
           where a.code_id = c.id and a.dotypos_customer_id = p.dotypos_customer_id
         ) as restricted, c.valid_until between c.created_at + interval '29 days 23 hours' and c.created_at + interval '30 days 1 hour' as valid_window
         from email_preparations p join email_discount_issuances i on i.preparation_id = p.id
         join discount_codes c on c.code = i.code where p.send_id = $1`,
          [sendId]
        ),
      issuanceIdentity,
    };
  };

  test("test mail issues nothing; real recipients get distinct codes and replay identical messages", async () => {
    const run = await setup("replay");
    expect(await run.staleWrite()).toBe("23514");
    await run.publishLater();
    run.answerWith("interrupt");
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    run.answerWith("accept");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    const [first, replay] = run.requests;
    expect(first?.messages.length).toBe(2);
    expect(
      first?.messages.every(
        ({ subject }) => subject === "Synthetic cowork offer"
      )
    ).toBe(true);
    expect(replay?.replay).toBe(true);
    expect(replay?.key === first?.key).toBe(true);
    expect(
      campaignDeliveryPayloadHash(first?.messages ?? []) ===
        campaignDeliveryPayloadHash(replay?.messages ?? [])
    ).toBe(true);
    const codes = first?.messages.map(bookingCode) ?? [];
    expect(codes.every((code) => Boolean(code && code !== "SAMPLE CODE"))).toBe(
      true
    );
    expect(new Set(codes).size).toBe(2);
    const now = Temporal.Now.instant();
    for (const [index, message] of (first?.messages ?? []).entries()) {
      const code = bookingCode(message);
      if (!code) throw new Error("The booking link did not contain a code");
      const owner = run.recipients[index]?.dotyposCustomerId;
      const other = run.recipients[1 - index]?.dotyposCustomerId;
      assert(owner && other, "Expected a pair of campaign recipients");
      expect(Exit.isSuccess(await validatesAtCheckout(code, owner, now))).toBe(
        true
      );
      expect(Exit.isFailure(await validatesAtCheckout(code, other, now))).toBe(
        true
      );
      expect(
        Exit.isFailure(
          await validatesAtCheckout(code, owner, now.add({ hours: 31 * 24 }))
        )
      ).toBe(true);
    }
    const issued = await run.issued();
    expect(issued.rows).toEqual([
      { enabled: true, restricted: true, valid_window: true },
      { enabled: true, restricted: true, valid_window: true },
    ]);
    const skipped = await pool.query<{ skip_reason: string }>(
      "select skip_reason from email_campaign_recipients where send_id = $1 and status = 'skipped' order by skip_reason",
      [run.sendId]
    );
    expect(skipped.rows.map(({ skip_reason }) => skip_reason)).toEqual([
      "consent-withdrawn",
      "missing-email-language",
    ]);
  });

  test("linked campaign writes, list and detail show current draft and frozen send locales", async () => {
    const run = await setup("locales", { checkLocales: true });
    await run.checkFrozenLocales();
  });

  test("a definitive first refusal disables codes and ends retry for those recipients", async () => {
    const run = await setup("refusal");
    run.answerWith("refuse");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    const issued = await run.issued();
    expect(issued.rows.map(({ enabled }) => enabled)).toEqual([false, false]);
    expect(Exit.isFailure(await run.retry())).toBe(true);
    expect(run.requests.length).toBe(1);
  });

  test("a final per-recipient refusal can hide an uncertain fallback and keeps codes active", async () => {
    const run = await setup("fallback");
    run.answerWith("opaque-refusal");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
    expect(Exit.isFailure(await run.retry(false))).toBe(true);
  });

  test("an unresolved attempt keeps codes active through replay refusal and a later retry refusal", async () => {
    const run = await setup("uncertain");
    run.answerWith("interrupt");
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    run.answerWith("refuse");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(Exit.isSuccess(await run.retry())).toBe(true);
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
    expect(run.requests.map(({ replay }) => replay)).toEqual([
      false,
      true,
      false,
    ]);
    const hashes = run.requests.map(({ messages }) =>
      campaignDeliveryPayloadHash(messages)
    );
    expect(new Set(hashes).size).toBe(1);
  });

  test("temporary value failure preserves the already issued code and expiry for retry", async () => {
    const run = await setup("temporary", { includeCustomerValue: true });
    run.setCustomerValuesAvailable(false);
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(run.requests.length).toBe(0);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
    const issued = await run.issuanceIdentity();
    run.setCustomerValuesAvailable(true);
    expect(Exit.isSuccess(await run.retry())).toBe(true);
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(run.requests[0]?.messages.length).toBe(2);
    expect((await run.issuanceIdentity()) === issued).toBe(true);
  });

  test.each(["address", "analytics identity"] as const)(
    "an explicit retry skips only the recipient whose %s changed",
    async (changed) => {
      const run = await setup(changed === "address" ? "moved" : "analytics", {
        includeAnalytics: changed === "analytics identity",
      });
      run.answerWith("interrupt");
      expect(Exit.isFailure(await run.deliver())).toBe(true);
      const issued = await run.issuanceIdentity();
      if (changed === "address") {
        run.moveFirstRecipient();
      } else {
        expect(
          run.requests[0]?.messages.every(
            ({ recipientIdentity }) => recipientIdentity !== undefined
          )
        ).toBe(true);
        run.withdrawFirstAnalyticsGrant();
      }
      run.answerWith("accept");
      expect(Exit.isSuccess(await run.deliver())).toBe(true);
      expect(Exit.isSuccess(await run.retry())).toBe(true);
      expect(Exit.isSuccess(await run.deliver())).toBe(true);
      const [first, retry] = run.requests;
      expect(run.requests.length).toBe(2);
      expect(retry?.replay).toBe(false);
      expect(retry?.messages.length).toBe(1);
      expect(
        campaignDeliveryPayloadHash(retry?.messages ?? []) ===
          campaignDeliveryPayloadHash(first?.messages.slice(1) ?? [])
      ).toBe(true);
      expect((await run.issuanceIdentity()) === issued).toBe(true);
      expect((await run.issued()).rows.every(({ enabled }) => enabled)).toBe(
        true
      );
    }
  );

  test.each(["withdraw", "disable"] as const)(
    "eligibility change (%s) just before the first request keeps the other recipient deliverable",
    async (change) => {
      const run = await setup(`late-${change}`);
      run.changeEligibilityBeforeRequest(change);
      expect(Exit.isSuccess(await run.deliver())).toBe(true);
      expect(run.requests.length).toBe(1);
      expect(run.requests[0]?.messages.length).toBe(1);
      expect(await run.hasOriginalIssuance()).toBe(true);
      const code = bookingCode(run.requests[0]?.messages[0]);
      if (!code) throw new Error("The booking link did not contain a code");
      expect(
        Exit.isSuccess(
          await validatesAtCheckout(
            code,
            run.recipients[1].dotyposCustomerId,
            Temporal.Now.instant()
          )
        )
      ).toBe(true);
      expect(
        (await run.issued()).rows.filter(({ enabled }) => enabled).length
      ).toBe(1);
      const { rows } = await pool.query(
        "select status, skip_reason from email_campaign_recipients where send_id = $1 and dotypos_customer_id = $2",
        [run.sendId, run.recipients[0].dotyposCustomerId]
      );
      expect(rows).toEqual([
        change === "withdraw"
          ? { status: "skipped", skip_reason: "consent-withdrawn" }
          : { status: "failed", skip_reason: null },
      ]);
    }
  );

  test("a resumed batch stays a possible replay even if the first run stopped before admission", async () => {
    const run = await setup("before-admission");
    run.interruptBeforeAdmission();
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    run.changeEligibilityBeforeRequest("withdraw");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(run.requests.length).toBe(0);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
    const unresolved = await pool.query(
      "select 1 from email_campaign_recipients where send_id = $1 and status = 'unconfirmed'",
      [run.sendId]
    );
    expect(unresolved.rowCount).toBe(2);
  });

  test("disabling an already dispatched offer keeps the next recipient deliverable", async () => {
    const run = await setup("admitted-peer");
    run.disableFirstCodeAfterRequest();
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(run.requests.map(({ messages }) => messages.length)).toEqual([1, 1]);
    const delivered = await pool.query(
      "select 1 from email_campaign_recipients where send_id = $1 and status = 'sent'",
      [run.sendId]
    );
    expect(delivered.rowCount).toBe(2);
  });

  test.each([
    [401, 2],
    [503, 6],
  ] as const)(
    "a withdrawal after PostHog refusals (%i) leaves the Resend fallback peer deliverable",
    async (status, postHogAttempts) => {
      const tag = `fallback-withdrawal-${status}`;
      const persistedBatches = async () =>
        (
          await pool.query<{
            send_id: Parameters<
              typeof campaignDeliveryBatchIdempotencyKey
            >[0]["sendId"];
            delivery_attempt: number;
            batch_index: number;
            payload_hash: string;
            dotypos_customer_ids: string[];
          }>(
            "select send_id, delivery_attempt, batch_index, payload_hash, dotypos_customer_ids from email_campaign_delivery_batches where $1 = any(dotypos_customer_ids)",
            [`${tag}-second`]
          )
        ).rows;
      let pinned: Awaited<ReturnType<typeof persistedBatches>> = [];
      let postHogRequests = 0;
      const postHogFetch = Object.assign(
        async () => {
          postHogRequests += 1;
          return Response.json({ code: "synthetic_refusal" }, { status });
        },
        { preconnect: globalThis.fetch.preconnect }
      );
      const postHog = makePostHogEmailProvider({
        secretKey: Redacted.make("synthetic-posthog-key"),
        host: "https://posthog.synthetic.invalid",
        systemIdentity: "synthetic-email-system",
      });
      const resend = makeResendEmailProvider({
        apiKey: "synthetic-resend-key",
        timeouts: resendRequestTimeouts.nonProduction,
      });
      const marketingProviders: readonly EmailProvider[] = [
        {
          ...postHog,
          sendBatch: (messages, options) =>
            postHog
              .sendBatch(messages, options)
              .pipe(Effect.provideService(FetchHttpClient.Fetch, postHogFetch)),
        },
        {
          ...resend,
          // Both PostHog requests are over; Resend has not asked admission yet.
          sendBatch: (messages, options) =>
            Effect.promise(async () => {
              if (pinned.length > 0) return;
              pinned = await persistedBatches();
              await pool.query(
                "update customer_marketing_consents set withdrawn_at = now() where dotypos_customer_id = $1",
                [`${tag}-first`]
              );
            }).pipe(Effect.andThen(resend.sendBatch(messages, options))),
        },
      ];
      const run = await setup(tag, { marketingProviders });
      const resendRequests: {
        url: string;
        key: string | null;
        body: string;
      }[] = [];
      const fetching = stubFetch(async (url, init) => {
        const body = String(init?.body);
        resendRequests.push({
          url: String(url),
          key: new Headers(init?.headers).get("Idempotency-Key"),
          body,
        });
        return Response.json({
          data: decodeResendBatch(body).map((_, index) => ({
            id: `synthetic-resend-${status}-${index}`,
          })),
        });
      });
      try {
        expect(Exit.isSuccess(await run.deliver())).toBe(true);
        expect(postHogRequests).toBe(postHogAttempts);
        expect(resendRequests.length).toBe(1);
        // Redelivery neither replays the original batch nor sends the subset again.
        expect(Exit.isSuccess(await run.deliver())).toBe(true);
        expect(postHogRequests).toBe(postHogAttempts);
        expect(resendRequests.length).toBe(1);
      } finally {
        fetching.mockRestore();
      }
      const [first, second] = run.recipients;
      const [request] = resendRequests;
      assert(request, "Expected the Resend fallback request");
      expect(request.url.endsWith("/emails/batch")).toBe(true);
      const sent = decodeResendBatch(request.body);
      expect(sent.length).toBe(1);
      expect([sent[0]?.to].flat().join() === second.email).toBe(true);

      expect(pinned.length).toBe(1);
      expect(await persistedBatches()).toEqual(pinned);
      const [batch] = pinned;
      assert(batch, "Expected a persisted delivery batch");
      const eligible = batch.dotypos_customer_ids.indexOf(`${tag}-second`);
      const subset = createHash("sha256")
        .update(`1:${eligible}`)
        .digest("hex")
        .slice(0, 16);
      const batchKey = campaignDeliveryBatchIdempotencyKey({
        sendId: batch.send_id,
        deliveryAttempt: batch.delivery_attempt,
        batchIndex: batch.batch_index,
      });
      expect(request.key).toBe(`${batchKey}:fallback:${subset}`);

      const { rows } = await pool.query(
        `select r.status, r.provider_message_id, p.delivery_outcome
         from email_campaign_recipients r
         join email_preparations p on p.send_id = r.send_id and p.dotypos_customer_id = r.dotypos_customer_id
         where r.send_id = $1 and r.dotypos_customer_id in ($2, $3)
         order by r.dotypos_customer_id`,
        [run.sendId, first.dotyposCustomerId, second.dotyposCustomerId]
      );
      // The withdrawn recipient keeps the uncertainty of its PostHog request.
      expect(rows).toEqual([
        {
          status: "unconfirmed",
          provider_message_id: null,
          delivery_outcome: "uncertain",
        },
        {
          status: "sent",
          provider_message_id: `synthetic-resend-${status}-0`,
          delivery_outcome: "accepted",
        },
      ]);

      const issued = await pool.query<{ code: string; customer: string }>(
        "select i.code, p.dotypos_customer_id as customer from email_discount_issuances i join email_preparations p on p.id = i.preparation_id where p.send_id = $1 order by p.dotypos_customer_id",
        [run.sendId]
      );
      const [withdrawnCode, eligibleCode] = issued.rows.map(({ code }) => code);
      assert(withdrawnCode && eligibleCode, "Expected both issued codes");
      expect(request.body.includes(withdrawnCode)).toBe(false);
      expect(request.body.includes(first.email)).toBe(false);
      expect(bookingCode(sent[0]) === eligibleCode).toBe(true);
      expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
        true,
        true,
      ]);
      const artifacts = `${request.key}${run.logged.join("")}${JSON.stringify(rows)}`;
      const privateValues = [
        first.email,
        second.email,
        first.dotyposCustomerId,
        second.dotyposCustomerId,
        withdrawnCode,
        eligibleCode,
      ];
      expect(privateValues.some((value) => artifacts.includes(value))).toBe(
        false
      );
    },
    20_000
  );

  test("a competing delivery cannot issue a second set of codes or request a second batch", async () => {
    const run = await setup("competing");
    const paused = run.pauseDelivery();
    const delivering = run.deliver();
    try {
      await Promise.race([
        paused.called,
        delivering.then(() => {
          throw new Error("Delivery exited before reaching the provider");
        }),
      ]);
      expect(Exit.isFailure(await run.deliver())).toBe(true);
    } finally {
      paused.resume();
      await delivering;
    }
    expect(run.requests.length).toBe(1);
    expect((await run.issued()).rowCount).toBe(2);
  });

  test("an abandoned requested batch requires explicit retry of uncertain delivery", async () => {
    const run = await setup("abandoned");
    run.answerWith("interrupt");
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    await run.abandon();
    expect(Exit.isFailure(await run.retry(false))).toBe(true);
    expect(Exit.isSuccess(await run.retry())).toBe(true);
    run.answerWith("refuse");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect((await run.issued()).rows.map(({ enabled }) => enabled)).toEqual([
      true,
      true,
    ]);
  });

  test("a disabled code prevents replay of an unresolved batch", async () => {
    const run = await setup("disabled");
    run.answerWith("interrupt");
    expect(Exit.isFailure(await run.deliver())).toBe(true);
    await pool.query(
      "update discount_codes set enabled = false where id in (select code_id from discount_code_customers where dotypos_customer_id = $1)",
      [run.recipients[0].dotyposCustomerId]
    );
    run.answerWith("accept");
    expect(Exit.isSuccess(await run.deliver())).toBe(true);
    expect(run.requests.length).toBe(1);
    const pending = await pool.query(
      "select 1 from email_campaign_recipients where send_id = $1 and status = 'unconfirmed'",
      [run.sendId]
    );
    expect(pending.rowCount).toBe(2);
  });
});
