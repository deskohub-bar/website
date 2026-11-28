import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  EMAIL_TEST_DOMAIN,
  resendSimulatorAddress,
  testEmailAddress,
} from "@deskohub/test-email";
import { Effect, Layer, Predicate, References } from "effect";
import {
  type EmailBatchResult,
  EmailDeliveryIdSchema,
  type EmailMessage,
  type EmailProviderConfig,
} from "../types/email.types";
import {
  EmailDeliveryObserver,
  type EmailDeliveryObserver as EmailDeliveryObserverShape,
  type EmailFallbackEvent,
  type EmailSentEvent,
} from "./email-delivery-observer";
import { makeEmailProviderFake } from "./email-provider.test-utils";
import { type EmailProviderChains, EmailProviders } from "./email-providers";
import { NetworkError } from "./network-error";
import {
  EmailConfigTag,
  type EmailProvider,
  type EmailSendError,
  EmailServiceError,
  EmailServiceTag,
} from "./service";

const config: EmailProviderConfig = {
  provider: "console",
  defaultFrom: { email: testEmailAddress("deskohub"), name: "Deskohub" },
};

// A real destination, so the message goes through the provider chain.
const realRecipient = { email: resendSimulatorAddress("delivered", "ada") };

const message: EmailMessage = {
  from: config.defaultFrom,
  to: realRecipient,
  subject: "Hello",
  html: "<p>Hello</p>",
  tags: ["workspace-contact"],
};

const campaign: EmailMessage = {
  ...message,
  tags: ["email-campaign"],
  metadata: { campaignSendId: "metadata-marker" },
};

const at = new Date("2026-11-09T10:00:00Z");

const providerLevel = (provider: string) =>
  new EmailServiceError("raw quota detail", undefined, provider, {
    failureKind: "provider",
    code: "http-429",
  });

const messageLevel = (provider: string) =>
  new EmailServiceError("raw validation detail", undefined, provider, {
    failureKind: "message",
    code: "http-422",
  });

type Answer = "accept" | EmailSendError;

/**
 * A provider that answers each message on its own, as a per-message API
 * does, and records every call.
 */
const scriptedProvider = (
  name: string,
  answer: (message: EmailMessage) => Answer
) => {
  const sends: EmailMessage[] = [];
  const batches: { messages: EmailMessage[]; idempotencyKey: string }[] = [];
  let nextId = 0;
  const answerOne = (sent: EmailMessage): EmailBatchResult => {
    const outcome = answer(sent);
    return outcome === "accept"
      ? {
          id: EmailDeliveryIdSchema.make(`${name}-${++nextId}`),
          status: "sent",
          provider: name,
          timestamp: at,
        }
      : { status: "failed", provider: name, timestamp: at, error: outcome };
  };
  const provider: EmailProvider = {
    name,
    send: (sent) =>
      Effect.suspend(() => {
        sends.push(sent);
        const result = answerOne(sent);
        return result.status === "failed"
          ? Effect.fail(result.error)
          : Effect.succeed(result);
      }),
    sendBatch: (sent, options) =>
      Effect.sync(() => {
        batches.push({
          messages: [...sent],
          idempotencyKey: options.idempotencyKey,
        });
        return sent.map(answerOne);
      }),
  };
  return { provider, sends, batches };
};

/** A provider whose every request fails as a whole with `error`. */
const failingProvider = (name: string, error: EmailSendError) => {
  const batches: { messages: EmailMessage[]; idempotencyKey: string }[] = [];
  let sends = 0;
  const provider: EmailProvider = {
    name,
    send: () =>
      Effect.suspend(() => {
        sends++;
        return Effect.fail(error);
      }),
    sendBatch: (sent, options) =>
      Effect.suspend(() => {
        batches.push({
          messages: [...sent],
          idempotencyKey: options.idempotencyKey,
        });
        return Effect.fail(error);
      }),
  };
  return { provider, batches, sends: () => sends };
};

const recordingObserver = () => {
  const sent: EmailSentEvent[] = [];
  const fallbacks: EmailFallbackEvent[] = [];
  const observer: EmailDeliveryObserverShape = {
    onSent: (event) => Effect.sync(() => void sent.push(event)),
    onFallback: (event) => Effect.sync(() => void fallbacks.push(event)),
  };
  return { observer, sent, fallbacks };
};

const chains = (
  overrides: Partial<EmailProviderChains>
): EmailProviderChains => ({
  transactional: [],
  marketing: [],
  marketingCategories: new Set(["email-campaign"]),
  ...overrides,
});

const runWithEmail = <A, E>(
  effect: Effect.Effect<A, E, EmailServiceTag>,
  providerChains: EmailProviderChains,
  options: {
    readonly observer?: EmailDeliveryObserverShape;
    readonly layer?: "Default" | "RecipientRouted";
  } = {}
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        EmailServiceTag[options.layer ?? "Default"].pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(EmailProviders, providerChains),
              Layer.succeed(EmailConfigTag, config),
              options.observer
                ? Layer.succeed(EmailDeliveryObserver, options.observer)
                : Layer.empty
            )
          )
        )
      )
    )
  );

const send = (sent: EmailMessage) =>
  Effect.gen(function* () {
    const email = yield* EmailServiceTag;
    return yield* email.send(sent);
  });

const sendBatch = (sent: readonly EmailMessage[], idempotencyKey = "batch-1") =>
  Effect.gen(function* () {
    const email = yield* EmailServiceTag;
    return yield* email.sendBatch(sent, { idempotencyKey });
  });

describe("provider chain selection", () => {
  test("marketing categories use the marketing chain, every other message the transactional one", async () => {
    const transactional = scriptedProvider("transactional", () => "accept");
    const marketing = scriptedProvider("marketing", () => "accept");
    const providerChains = chains({
      transactional: [transactional.provider],
      marketing: [marketing.provider],
    });

    const results = await runWithEmail(
      Effect.all([
        send(message),
        send(campaign),
        send({ ...message, tags: undefined }),
      ]),
      providerChains
    );

    expect(results.map((result) => result.provider)).toEqual([
      "transactional",
      "marketing",
      "transactional",
    ]);
  });

  test("only the first tag is the category", async () => {
    const transactional = scriptedProvider("transactional", () => "accept");
    const marketing = scriptedProvider("marketing", () => "accept");

    const result = await runWithEmail(
      send({ ...message, tags: ["workspace-contact", "email-campaign"] }),
      chains({
        transactional: [transactional.provider],
        marketing: [marketing.provider],
      })
    );

    expect(result.provider).toBe("transactional");
  });
});

describe("single-send failover", () => {
  test("moves to the next provider after a provider-level refusal and reports both events", async () => {
    const first = failingProvider("posthog", providerLevel("posthog"));
    const second = scriptedProvider("resend", () => "accept");
    const recorded = recordingObserver();

    const result = await runWithEmail(
      send({ ...campaign, idempotencyKey: "campaign-key" }),
      chains({ marketing: [first.provider, second.provider] }),
      { observer: recorded.observer }
    );

    expect(result.provider).toBe("resend");
    expect(first.sends()).toBe(1);
    expect(recorded.fallbacks).toEqual([
      {
        stream: "marketing",
        category: "email-campaign",
        failedProvider: "posthog",
        nextProvider: "resend",
        errorKind: "EmailServiceError",
        errorCode: "http-429",
        at: expect.any(Date),
      },
    ]);
    expect(recorded.sent).toEqual([
      {
        provider: "resend",
        deliveryId: result.id,
        stream: "marketing",
        category: "email-campaign",
        tags: ["email-campaign"],
        metadata: { campaignSendId: "metadata-marker" },
        idempotencyKey: "campaign-key",
        at: expect.any(Date),
      },
    ]);
  });

  test("moves on after a provider-level transport failure without retrying it", async () => {
    const first = failingProvider(
      "posthog",
      new NetworkError({ message: "timed out", code: "timeout" })
    );
    const second = scriptedProvider("resend", () => "accept");
    const recorded = recordingObserver();

    const result = await runWithEmail(
      send(campaign),
      chains({ marketing: [first.provider, second.provider] }),
      { observer: recorded.observer }
    );

    expect(result.provider).toBe("resend");
    expect(first.sends()).toBe(1);
    expect(
      recorded.fallbacks.map((event) => [event.errorKind, event.errorCode])
    ).toEqual([["NetworkError", "timeout"]]);
  });

  test.each([
    ["a message-level refusal", messageLevel("posthog")],
    [
      "an outcome a replay must settle",
      new NetworkError({
        message: "key in flight",
        code: "http-409",
        failureKind: "unknown-outcome",
      }),
    ],
  ])("stops the chain after %s", async (_label, error) => {
    const first = failingProvider("posthog", error);
    const second = scriptedProvider("resend", () => "accept");
    const recorded = recordingObserver();

    const outcome = await runWithEmail(
      send(campaign).pipe(Effect.flip),
      chains({ marketing: [first.provider, second.provider] }),
      { observer: recorded.observer }
    );

    expect(outcome).toBe(error);
    expect(second.sends).toHaveLength(0);
    expect(recorded.fallbacks).toEqual([]);
    expect(recorded.sent).toEqual([]);
  });

  test("fails with the last provider's error when every provider fails", async () => {
    const lastError = providerLevel("resend");
    const outcome = await runWithEmail(
      send(campaign).pipe(Effect.flip),
      chains({
        marketing: [
          failingProvider("posthog", providerLevel("posthog")).provider,
          failingProvider("resend", lastError).provider,
        ],
      })
    );

    expect(outcome).toBe(lastError);
  });
});

describe("attachments", () => {
  const withAttachment: EmailMessage = {
    ...campaign,
    attachments: [{ filename: "invoice.pdf", content: "pdf" }],
  };

  test("a provider that cannot carry attachments ends the chain before any request", async () => {
    const noAttachments = makeEmailProviderFake({
      name: "posthog",
      sendsAttachments: false,
    });
    const resend = scriptedProvider("resend", () => "accept");

    const outcome = await runWithEmail(
      send(withAttachment).pipe(Effect.flip),
      chains({ marketing: [noAttachments.provider, resend.provider] })
    );

    expect(outcome).toMatchObject({
      _tag: "EmailServiceError",
      failureKind: "message",
      code: "attachments-unsupported",
    });
    expect(noAttachments.requests()).toEqual([]);
    expect(resend.sends).toHaveLength(0);
  });

  test("never falls back to a provider that cannot carry attachments", async () => {
    const noAttachments = makeEmailProviderFake({
      name: "posthog",
      sendsAttachments: false,
    });

    const outcome = await runWithEmail(
      send(withAttachment).pipe(Effect.flip),
      chains({
        marketing: [
          failingProvider("resend", providerLevel("resend")).provider,
          noAttachments.provider,
        ],
      })
    );

    expect(outcome).toMatchObject({ code: "attachments-unsupported" });
    expect(noAttachments.requests()).toEqual([]);
    expect(noAttachments.mailed()).toEqual([]);
  });
});

describe("batch failover", () => {
  const batchRecipient = (name: string) =>
    resendSimulatorAddress("delivered", name);
  const recipients = ["accepted", "throttled", "invalid", "in-flight"].map(
    (name): EmailMessage => ({
      ...campaign,
      to: { email: batchRecipient(name) },
    })
  );
  const firstAnswer = (sent: EmailMessage): Answer => {
    const [recipient] = [sent.to].flat();
    switch (recipient?.email) {
      case batchRecipient("throttled"):
        return providerLevel("posthog");
      case batchRecipient("invalid"):
        return messageLevel("posthog");
      case batchRecipient("in-flight"):
        return new NetworkError({
          message: "key in flight",
          code: "http-409",
          failureKind: "unknown-outcome",
        });
      default:
        return "accept";
    }
  };

  test("sends only provider-level failures to the next provider and keeps message order", async () => {
    const first = scriptedProvider("posthog", firstAnswer);
    const second = scriptedProvider("resend", () => "accept");
    const recorded = recordingObserver();

    const results = await runWithEmail(
      sendBatch(recipients),
      chains({ marketing: [first.provider, second.provider] }),
      { observer: recorded.observer }
    );

    expect(results.map((result) => [result.status, result.provider])).toEqual([
      ["sent", "posthog"],
      ["sent", "resend"],
      ["failed", "posthog"],
      ["failed", "posthog"],
    ]);
    expect(results[2]).toMatchObject({ error: { code: "http-422" } });
    expect(results[3]).toMatchObject({
      error: { _tag: "NetworkError", failureKind: "unknown-outcome" },
    });
    expect(first.batches.map((batch) => batch.idempotencyKey)).toEqual([
      "batch-1",
    ]);
    expect(second.batches).toHaveLength(1);
    expect(second.batches[0]?.messages.map((sent) => sent.to)).toEqual([
      { email: batchRecipient("throttled") },
    ]);
    expect(second.batches[0]?.idempotencyKey).toMatch(
      /^batch-1:fallback:[0-9a-f]{16}$/
    );
    expect(recorded.sent.map((event) => event.provider)).toEqual([
      "posthog",
      "resend",
    ]);
    expect(recorded.fallbacks).toEqual([
      {
        stream: "marketing",
        category: "email-campaign",
        failedProvider: "posthog",
        nextProvider: "resend",
        errorKind: "EmailServiceError",
        errorCode: "http-429",
        at: expect.any(Date),
      },
    ]);
  });

  test("derives the same fallback key for the same subset", async () => {
    const keys: (string | undefined)[] = [];
    for (const _attempt of [1, 2]) {
      const second = scriptedProvider("resend", () => "accept");
      await runWithEmail(
        sendBatch(recipients),
        chains({
          marketing: [
            scriptedProvider("posthog", firstAnswer).provider,
            second.provider,
          ],
        })
      );
      keys.push(second.batches[0]?.idempotencyKey);
    }

    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]);
  });

  test("a whole-batch provider-level failure moves the whole batch on under the caller's key", async () => {
    const second = scriptedProvider("resend", () => "accept");

    const results = await runWithEmail(
      sendBatch(recipients),
      chains({
        marketing: [
          failingProvider("posthog", providerLevel("posthog")).provider,
          second.provider,
        ],
      })
    );

    expect(results.every((result) => result.status === "sent")).toBe(true);
    expect(second.batches.map((batch) => batch.idempotencyKey)).toEqual([
      "batch-1",
    ]);
  });

  test("without a fallback, a whole-batch failure fails the call as before", async () => {
    const error = new NetworkError({ message: "timed out", code: "timeout" });

    const outcome = await runWithEmail(
      sendBatch(recipients).pipe(Effect.flip),
      chains({ marketing: [failingProvider("resend", error).provider] })
    );

    expect(outcome).toBe(error);
  });

  test("a batch with a request guard stays with the first provider", async () => {
    const error = providerLevel("posthog");
    const second = scriptedProvider("resend", () => "accept");

    const outcome = await runWithEmail(
      Effect.gen(function* () {
        const email = yield* EmailServiceTag;
        return yield* email.sendBatch(recipients.slice(0, 1), {
          idempotencyKey: "guarded",
          beforeRequest: () => Effect.void,
        });
      }).pipe(Effect.flip),
      chains({
        marketing: [
          failingProvider("posthog", error).provider,
          second.provider,
        ],
      })
    );

    expect(outcome).toBe(error);
    expect(second.batches).toEqual([]);
  });

  test("a guarded batch can check admission again on allowed provider fallback", async () => {
    const transactional = scriptedProvider("transactional", () => "accept");
    const first = scriptedProvider("posthog", firstAnswer);
    const second = scriptedProvider("resend", () => "accept");
    const admitted: [string, readonly number[]][] = [];
    const withAdmission = (provider: EmailProvider): EmailProvider => ({
      ...provider,
      sendBatch: (messages, options) =>
        (
          options.beforeRequest?.(
            provider.name,
            messages.map((_, position) => position)
          ) ?? Effect.void
        ).pipe(Effect.andThen(provider.sendBatch(messages, options))),
    });
    const results = await runWithEmail(
      Effect.flatMap(EmailServiceTag, (email) =>
        email.sendBatch([message, ...recipients], {
          idempotencyKey: "recheck-on-fallback",
          allowFallbackWithAdmission: true,
          beforeRequest: (fingerprint, positions) =>
            Effect.sync(() => void admitted.push([fingerprint, positions])),
        })
      ),
      chains({
        transactional: [withAdmission(transactional.provider)],
        marketing: [
          withAdmission(first.provider),
          withAdmission(second.provider),
        ],
      })
    );
    expect(admitted).toEqual([
      ["transactional", [0]],
      ["posthog", [1, 2, 3, 4]],
      ["resend", [2]],
    ]);
    expect(results.map(({ status, provider }) => [status, provider])).toEqual([
      ["sent", "transactional"],
      ["sent", "posthog"],
      ["sent", "resend"],
      ["failed", "posthog"],
      ["failed", "posthog"],
    ]);
  });

  test("a refused fallback admission resends only the still-admissible messages, under each subset's key", async () => {
    const transactional = scriptedProvider("transactional", () => "accept");
    const fallback = makeEmailProviderFake({ name: "resend" });
    const asked: (readonly number[])[] = [];
    const results = await runWithEmail(
      Effect.flatMap(EmailServiceTag, (email) =>
        email.sendBatch([message, ...recipients], {
          idempotencyKey: "membership-drift",
          allowFallbackWithAdmission: true,
          beforeRequest: (_fingerprint, positions) =>
            Effect.suspend(() => {
              asked.push(positions);
              // One more recipient becomes ineligible at each of two checks.
              return asked.length <= 2
                ? Effect.fail(
                    new EmailServiceError("denied", undefined, undefined, {
                      deniedPositions: [1],
                    })
                  )
                : Effect.void;
            }),
        })
      ),
      chains({
        transactional: [transactional.provider],
        marketing: [
          failingProvider("posthog", providerLevel("posthog")).provider,
          fallback.provider,
        ],
      })
    );

    expect(asked).toEqual([
      [1, 2, 3, 4],
      [1, 3, 4],
      [1, 4],
    ]);
    const subset = createHash("sha256").update("1:0,3").digest("hex");
    expect(fallback.requests().map(({ key }) => key)).toEqual([
      `membership-drift:marketing:fallback:${subset.slice(0, 16)}`,
    ]);
    expect(fallback.mailed()).toEqual([
      batchRecipient("accepted"),
      batchRecipient("in-flight"),
    ]);
    expect(results.map(({ status }) => status)).toEqual([
      "sent",
      "sent",
      "failed",
      "failed",
      "sent",
    ]);
  });

  test.each([
    ["no position", []],
    ["every position", [0, 1, 2, 3]],
    ["a repeated position", [1, 1]],
    ["a position outside the request", [4]],
    ["a negative position", [-1]],
    ["a fractional position", [0.5]],
  ])(
    "a fallback denial naming %s sends nothing",
    async (_, deniedPositions) => {
      const fallback = makeEmailProviderFake({ name: "resend" });
      let checks = 0;
      const results = await runWithEmail(
        Effect.flatMap(EmailServiceTag, (email) =>
          email.sendBatch(recipients, {
            idempotencyKey: "invalid-denial",
            allowFallbackWithAdmission: true,
            beforeRequest: () =>
              Effect.suspend(() => {
                checks++;
                return Effect.fail(
                  new EmailServiceError("denied", undefined, undefined, {
                    deniedPositions,
                  })
                );
              }),
          })
        ),
        chains({
          marketing: [
            failingProvider("posthog", providerLevel("posthog")).provider,
            fallback.provider,
          ],
        })
      );

      expect(checks).toBe(1);
      expect(fallback.requests()).toEqual([]);
      expect(results.every(({ status }) => status === "failed")).toBe(true);
    }
  );

  test("a denial after an admitted fallback attempt never repacks the batch", async () => {
    const fallback = makeEmailProviderFake({ name: "resend" });
    fallback.respondWith(() => "unavailable");
    const retrying: EmailProvider = {
      ...fallback.provider,
      sendBatch: (messages, options) =>
        fallback.provider
          .sendBatch(messages, options)
          .pipe(
            Effect.catch(() => fallback.provider.sendBatch(messages, options))
          ),
    };
    let checks = 0;
    const results = await runWithEmail(
      Effect.flatMap(EmailServiceTag, (email) =>
        email.sendBatch(recipients, {
          idempotencyKey: "dispatched-fallback",
          allowFallbackWithAdmission: true,
          beforeRequest: () =>
            Effect.suspend(() =>
              ++checks === 1
                ? Effect.void
                : Effect.fail(
                    new EmailServiceError("denied", undefined, undefined, {
                      deniedPositions: [0],
                    })
                  )
            ),
        })
      ),
      chains({
        marketing: [
          failingProvider("posthog", providerLevel("posthog")).provider,
          retrying,
        ],
      })
    );

    expect(fallback.requests().map(({ key }) => key)).toEqual([
      "dispatched-fallback",
    ]);
    expect(results.every(({ status }) => status === "failed")).toBe(true);
  });

  test.each([
    ["a first provider", { allowFallbackWithAdmission: true }],
    ["a replay", { allowFallbackWithAdmission: true, replay: true }],
    ["a guard without fallback", {}],
  ])("%s never repacks a denied batch", async (_, options) => {
    const first = makeEmailProviderFake({ name: "posthog" });
    const second = makeEmailProviderFake({ name: "resend" });
    const denied = new EmailServiceError("denied", undefined, undefined, {
      deniedPositions: [0],
    });
    let checks = 0;
    const outcome = await runWithEmail(
      Effect.flatMap(EmailServiceTag, (email) =>
        email.sendBatch(recipients, {
          ...options,
          idempotencyKey: "pinned-batch",
          beforeRequest: () =>
            Effect.suspend(() => {
              checks++;
              return Effect.fail(denied);
            }),
        })
      ).pipe(Effect.flip),
      chains({ marketing: [first.provider, second.provider] })
    );

    expect(outcome).toBe(denied);
    expect(checks).toBe(1);
    expect([...first.requests(), ...second.requests()]).toEqual([]);
  });

  test("after a fallback, a whole-batch failure comes back per message", async () => {
    const error = new NetworkError({ message: "timed out", code: "timeout" });

    const results = await runWithEmail(
      sendBatch(recipients),
      chains({
        marketing: [
          failingProvider("posthog", providerLevel("posthog")).provider,
          failingProvider("resend", error).provider,
        ],
      })
    );

    expect(results).toHaveLength(recipients.length);
    for (const result of results) {
      expect(result).toMatchObject({
        status: "failed",
        provider: "resend",
        error,
      });
    }
  });

  test("a replay keeps every message with the first provider of its chain", async () => {
    const first = scriptedProvider("posthog", firstAnswer);
    const second = scriptedProvider("resend", () => "accept");
    const recorded = recordingObserver();

    const results = await runWithEmail(
      Effect.gen(function* () {
        const email = yield* EmailServiceTag;
        return yield* email.sendBatch(recipients, {
          idempotencyKey: "batch-1",
          replay: true,
        });
      }),
      chains({ marketing: [first.provider, second.provider] }),
      { observer: recorded.observer }
    );

    expect(results.map((result) => [result.status, result.provider])).toEqual([
      ["sent", "posthog"],
      ["failed", "posthog"],
      ["failed", "posthog"],
      ["failed", "posthog"],
    ]);
    expect(results[1]).toMatchObject({ error: { code: "http-429" } });
    expect(first.batches.map((batch) => batch.idempotencyKey)).toEqual([
      "batch-1",
    ]);
    expect(second.batches).toEqual([]);
    expect(recorded.fallbacks).toEqual([]);
  });

  test("an empty batch sends nothing", async () => {
    const provider = scriptedProvider("resend", () => "accept");

    const results = await runWithEmail(
      sendBatch([]),
      chains({ transactional: [provider.provider] })
    );

    expect(results).toEqual([]);
    expect(provider.batches).toEqual([]);
  });
});

describe("delivery observer", () => {
  const captureConsole = (): string[] & { restore: () => void } => {
    const lines: string[] = [];
    // biome-ignore lint/suspicious/noConsole: The test captures log output.
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(
        args
          .map((arg) =>
            Predicate.isString(arg) ? arg : (JSON.stringify(arg) ?? "")
          )
          .join(" ")
      );
    };
    return Object.assign(lines, {
      restore: () => {
        console.log = original;
      },
    });
  };

  test("EmailDeliveryObserver.none is the default and logs each event's non-personal facts", async () => {
    const consoleLines = captureConsole();
    try {
      await runWithEmail(
        send(campaign).pipe(
          Effect.provideService(References.MinimumLogLevel, "Debug")
        ),
        chains({
          marketing: [
            failingProvider("posthog", providerLevel("posthog")).provider,
            scriptedProvider("resend", () => "accept").provider,
          ],
        })
      );
    } finally {
      consoleLines.restore();
    }

    const logged = consoleLines.join("\n");
    expect(logged).toContain("Email provider fallback observed");
    expect(logged).toContain("Email delivery observed");
    expect(logged).not.toContain(realRecipient.email);
    expect(logged).not.toContain("metadata-marker");
  });

  test("observer failures and defects never fail a send, and all() still reaches every observer", async () => {
    const recorded = recordingObserver();
    const failing: EmailDeliveryObserverShape = {
      onSent: () => Effect.die("observer defect"),
      onFallback: () => {
        throw new Error("observer threw before returning an effect");
      },
    };

    const result = await runWithEmail(
      send(campaign),
      chains({
        marketing: [
          failingProvider("posthog", providerLevel("posthog")).provider,
          scriptedProvider("resend", () => "accept").provider,
        ],
      }),
      {
        observer: EmailDeliveryObserver.all([failing, recorded.observer]),
      }
    );

    expect(result.provider).toBe("resend");
    expect(recorded.sent).toHaveLength(1);
    expect(recorded.fallbacks).toHaveLength(1);
  });
});

test("an observer that throws synchronously never fails a send", async () => {
  const throwing: EmailDeliveryObserverShape = {
    onSent: () => {
      throw new Error("observer threw");
    },
    onFallback: () => {
      throw new Error("observer threw");
    },
  };

  const result = await runWithEmail(
    send(campaign),
    chains({
      marketing: [
        failingProvider("posthog", providerLevel("posthog")).provider,
        scriptedProvider("resend", () => "accept").provider,
      ],
    }),
    { observer: throwing }
  );

  expect(result.provider).toBe("resend");
});

describe("Console routing", () => {
  const testRecipientAddress = testEmailAddress("delivered");
  const testRecipientMessage: EmailMessage = {
    ...message,
    to: { email: testRecipientAddress },
  };

  test("RecipientRouted sends mail for test recipients only through Console", async () => {
    const resend = scriptedProvider("resend", () => "accept");

    const results = await runWithEmail(
      Effect.all([
        send(testRecipientMessage),
        send({
          ...testRecipientMessage,
          to: { email: ` ${testRecipientAddress} ` },
        }),
        send({
          ...testRecipientMessage,
          to: { email: `@${EMAIL_TEST_DOMAIN}` },
        }),
        send({
          ...testRecipientMessage,
          cc: realRecipient,
        }),
      ]),
      chains({ transactional: [resend.provider] }),
      { layer: "RecipientRouted" }
    );

    expect(results.map((result) => result.provider)).toEqual([
      "console",
      "console",
      "console",
      "resend",
    ]);
  });

  test("RecipientRouted restores batch order across Console and the chain", async () => {
    const resend = scriptedProvider("resend", () => "accept");

    const results = await runWithEmail(
      sendBatch([testRecipientMessage, message, testRecipientMessage]),
      chains({ transactional: [resend.provider] }),
      { layer: "RecipientRouted" }
    );

    expect(results.map((result) => result.provider)).toEqual([
      "console",
      "resend",
      "console",
    ]);
    expect(resend.batches.map((batch) => batch.messages.length)).toEqual([1]);
  });

  test("an empty chain sends every message through Console", async () => {
    const results = await runWithEmail(
      Effect.all([send(message), sendBatch([campaign, message])]),
      chains({}),
      { layer: "RecipientRouted" }
    );

    expect(
      [results[0], ...results[1]].map((result) => result.provider)
    ).toEqual(["console", "console", "console"]);
  });

  test("Default keeps test-recipient mail on the chain", async () => {
    const resend = scriptedProvider("resend", () => "accept");

    const result = await runWithEmail(
      send(testRecipientMessage),
      chains({ transactional: [resend.provider] })
    );

    expect(result.provider).toBe("resend");
  });
});

describe("idempotency keys", () => {
  test("gives separate deliveries separate keys", async () => {
    const provider = scriptedProvider("resend", () => "accept");

    await runWithEmail(
      Effect.all([send(message), send(message)]),
      chains({ transactional: [provider.provider] })
    );

    const [first, second] = provider.sends.map((sent) => sent.idempotencyKey);
    expect(first).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  test("derives reservation delivery keys, prefers an explicit key, and keeps it across providers", async () => {
    const first = failingProvider("posthog", providerLevel("posthog"));
    const provider = scriptedProvider("resend", () => "accept");

    await runWithEmail(
      Effect.all(
        ["workspace-paid-reservation-access", "workspace-invoice-customer"].map(
          (category) =>
            send({
              ...message,
              tags: [category],
              metadata: { workspaceReservationId: "reservation-id" },
            })
        )
      ).pipe(
        Effect.andThen(
          send({
            ...campaign,
            idempotencyKey: "campaign-attempt-2",
          })
        )
      ),
      chains({
        transactional: [provider.provider],
        marketing: [first.provider, provider.provider],
      })
    );

    expect(provider.sends.map((sent) => sent.idempotencyKey)).toEqual([
      "workspace-paid-reservation-access-reservation-id",
      "workspace-invoice-customer-reservation-id",
      "campaign-attempt-2",
    ]);
  });

  test("keeps the caller's sender", async () => {
    const provider = scriptedProvider("resend", () => "accept");
    const sender = { email: testEmailAddress("reservations"), name: "Desk" };

    await runWithEmail(
      send({ ...message, from: sender }),
      chains({ transactional: [provider.provider] })
    );

    expect(provider.sends[0]?.from).toEqual(sender);
  });
});

describe("censorship", () => {
  test("failure logs carry only the error tag, codes, and provider names", async () => {
    const lines: string[] = [];
    // biome-ignore lint/suspicious/noConsole: The test captures log output to assert censorship.
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => JSON.stringify(arg) ?? "").join(" "));
    };
    try {
      await runWithEmail(
        send(campaign).pipe(Effect.result),
        chains({
          marketing: [
            failingProvider("posthog", providerLevel("posthog")).provider,
            failingProvider("resend", messageLevel("resend")).provider,
          ],
        })
      );
    } finally {
      console.log = original;
    }

    const logged = lines.join("\n");
    expect(logged).toContain("EmailServiceError");
    expect(logged).toContain("http-429");
    expect(logged).not.toContain("raw quota detail");
    expect(logged).not.toContain("raw validation detail");
    expect(logged).not.toContain(realRecipient.email);
    expect(logged).not.toContain("Hello");
  });
});
