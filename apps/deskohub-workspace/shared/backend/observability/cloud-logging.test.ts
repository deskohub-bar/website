import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { testEmailAddress } from "@deskohub/test-email";
import { Effect, Logger } from "effect";
import { isSensitiveLogKey } from "../logging/censorship";
import {
  type CloudLoggingIdentity,
  type CloudLoggingRecord,
  cloudLoggingRecord,
  makeCloudLoggingLogger,
} from "./cloud-logging";

const identity: CloudLoggingIdentity = {
  deploymentStage: "preview",
  serviceRole: "web",
  revisionSha: "synthetic-sha",
  deploymentId: "workspace-00007-abc",
};

const privateAddress = testEmailAddress("cloud-logging-private");

/** Runs `effect` with a logger that keeps each structured record. */
const recordsOf = async (
  effect: Effect.Effect<void>,
  recordIdentity: CloudLoggingIdentity = identity
) => {
  const records: CloudLoggingRecord[] = [];
  await Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((options) => {
            records.push(cloudLoggingRecord(recordIdentity, options));
          }),
        ])
      )
    )
  );
  return records;
};

describe("cloudLoggingRecord", () => {
  test("carries severity, the static message and the Workspace labels", async () => {
    const [record] = await recordsOf(
      Effect.logWarning("Checkout provider slow.").pipe(
        Effect.annotateLogs({ operation: "checkout.submit" })
      )
    );

    expect(record).toMatchObject({
      severity: "WARNING",
      message: "Checkout provider slow.",
      "logging.googleapis.com/labels": {
        environment: "preview",
        service_role: "web",
        revision: "synthetic-sha",
        deployment_id: "workspace-00007-abc",
      },
      annotations: { operation: "checkout.submit" },
    });
    expect(Number.isNaN(Date.parse(record?.time ?? ""))).toBe(false);
  });

  test("names each record's event: its event annotation, else its static message", async () => {
    const records = await recordsOf(
      Effect.all([
        Effect.logInfo("Workspace runtime shutdown started.").pipe(
          Effect.annotateLogs({ event: "runtime.shutdown.started" })
        ),
        Effect.logInfo("Checkout provider slow.", { attempt: 2 }),
      ])
    );

    expect(records.map(({ event }) => event)).toEqual([
      "runtime.shutdown.started",
      "checkout_provider_slow",
    ]);
  });

  test("keeps one event and message across a call's numbered records", async () => {
    const records = await recordsOf(
      Effect.forEach([1, 2, 3], (attemptNumber) =>
        Effect.logWarning(`Nexi retry attempt #${attemptNumber}`, {
          attemptNumber,
        })
      ).pipe(Effect.asVoid)
    );

    expect(records.map(({ event, message }) => ({ event, message }))).toEqual(
      Array.from({ length: 3 }, () => ({
        event: "nexi_retry_attempt",
        message: "Nexi retry attempt",
      }))
    );
    expect(records.map(({ details }) => details)).toEqual([
      [{ attemptNumber: 1 }],
      [{ attemptNumber: 2 }],
      [{ attemptNumber: 3 }],
    ]);
  });

  test("links the record to the active trace and span", async () => {
    let spanIds: { traceId: string; spanId: string } | undefined;
    const [record] = await recordsOf(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        spanIds = { traceId: span.traceId, spanId: span.spanId };
        yield* Effect.logInfo("Reservation confirmed.");
      }).pipe(Effect.withSpan("reservation.confirm"))
    );

    expect(record?.trace_id).toBe(spanIds?.traceId);
    expect(record?.span_id).toBe(spanIds?.spanId);
  });

  test("passes annotations, details and causes through the shared censor", async () => {
    expect(isSensitiveLogKey("email")).toBe(true);
    const [record] = await recordsOf(
      Effect.logError("Magic link delivery failed.", {
        email: privateAddress,
      }).pipe(
        Effect.annotateLogs({ email: privateAddress }),
        Effect.withSpan("account.magic-link.deliver")
      )
    );

    expect(record?.severity).toBe("ERROR");
    expect(record?.message).toBe("Magic link delivery failed.");
    expect(JSON.stringify(record)).not.toContain(privateAddress);
  });

  test("records nothing outside a span as a trace", async () => {
    const [record] = await recordsOf(Effect.logInfo("Cache warmed."));

    expect(record?.severity).toBe("INFO");
    expect(record?.["logging.googleapis.com/spanId"]).toBeUndefined();
    expect(record?.trace_id).toBeUndefined();
  });
});

describe("makeCloudLoggingLogger", () => {
  const consoleLog = spyOn(console, "log").mockImplementation(() => undefined);

  afterEach(() => {
    consoleLog.mockClear();
  });

  test("writes one single-line JSON object per record to stdout", async () => {
    await Effect.runPromise(
      Effect.logInfo("Line one.\nstill line one").pipe(
        Effect.provide(Logger.layer([makeCloudLoggingLogger(identity)]))
      )
    );

    expect(consoleLog).toHaveBeenCalledTimes(1);
    const [line] = consoleLog.mock.calls[0] ?? [];
    expect(String(line)).not.toContain("\n");
    expect(JSON.parse(String(line))).toMatchObject({
      severity: "INFO",
      message: "Line one.\nstill line one",
    });
  });
});
