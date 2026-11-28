// Child process for hosted-payment-permit.service.test.ts: holds the permit
// from a separate process the way a Playwright worker does.
import { appendFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { runUntracedE2EEffect } from "../effect-edge";
import { WorkspaceE2EHostedPaymentPermitService } from "./hosted-payment-permit.service";

const holderInputSchema = Schema.Struct({
  capacity: Schema.Finite,
  crashWhileHolding: Schema.optionalKey(Schema.Boolean),
  directory: Schema.String,
  holdMs: Schema.Finite,
  label: Schema.String,
  logPath: Schema.String,
  sessions: Schema.Finite,
});

const input = Schema.decodeUnknownSync(
  Schema.fromJsonString(holderInputSchema)
)(process.argv[2]);

const record = (event: "start" | "end") =>
  Effect.promise(() =>
    appendFile(
      input.logPath,
      `${JSON.stringify({ at: performance.timeOrigin + performance.now(), event, label: input.label })}\n`
    )
  );

await runUntracedE2EEffect(
  Effect.gen(function* () {
    const permit = yield* WorkspaceE2EHostedPaymentPermitService;
    for (let session = 0; session < input.sessions; session += 1) {
      yield* permit.withPermit(
        `${input.label}-${session}`,
        Effect.gen(function* () {
          yield* record("start");
          if (input.crashWhileHolding) process.kill(process.pid, "SIGKILL");
          yield* Effect.sleep(`${input.holdMs} millis`);
          yield* record("end");
        })
      );
    }
  }).pipe(
    Effect.provide(
      WorkspaceE2EHostedPaymentPermitService.layer({
        capacity: input.capacity,
        directory: input.directory,
        pollIntervalMs: 10,
      })
    )
  )
);
