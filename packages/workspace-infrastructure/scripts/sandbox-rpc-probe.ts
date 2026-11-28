// Calls the sandbox probe image as the hosted proof's authenticated caller and
// prints one JSON verdict line (sandbox-probe/probe-client.ts). Exits 0 iff the
// verdict is ok. Never prints the ID token or the marker.
//   bun scripts/sandbox-rpc-probe.ts --url <service URL> --id-token-file <file> \
//     --marker-file <file> --traceparent <00-32hex-16hex-01> [--expect-version v1]
import { parseArgs } from "node:util";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { runEmailPreferencesProbe } from "../sandbox-probe/email-preferences-client";
import {
  runSandboxRpcProbe,
  setupFailureVerdict,
} from "../sandbox-probe/probe-client";

class ProbeVerdictFailed extends Schema.TaggedError<ProbeVerdictFailed>()(
  "ProbeVerdictFailed",
  { failures: Schema.Array(Schema.String) }
) {}

const ProbeArguments = Schema.Struct({
  url: Schema.String,
  "id-token-file": Schema.String,
  "marker-file": Schema.String,
  traceparent: Schema.String.check(
    Schema.isPattern(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  ),
  "expect-version": Schema.optionalKey(Schema.String),
  "email-preferences": Schema.optionalKey(Schema.Boolean),
});

class ProbeInputEmpty extends Schema.TaggedError<ProbeInputEmpty>()(
  "ProbeInputEmpty",
  { option: Schema.String }
) {}

/** File contents without the one trailing newline shell redirection adds. */
const readValueFile = (option: string, path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
    Effect.map((text) => text.replace(/\r?\n$/, "")),
    Effect.filterOrFail(
      (value) => value.length > 0,
      () => new ProbeInputEmpty({ option })
    )
  );

const probeTarget = Effect.gen(function* () {
  const { values } = yield* Effect.try(() =>
    parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        url: { type: "string" },
        "id-token-file": { type: "string" },
        "marker-file": { type: "string" },
        traceparent: { type: "string" },
        "expect-version": { type: "string" },
        "email-preferences": { type: "boolean" },
      },
    })
  );
  const options = yield* Schema.decodeUnknownEffect(ProbeArguments)(values);
  return {
    url: options.url,
    idToken: yield* readValueFile("--id-token-file", options["id-token-file"]),
    marker: yield* readValueFile("--marker-file", options["marker-file"]),
    traceparent: options.traceparent,
    expectVersion: options["expect-version"],
    emailPreferences: options["email-preferences"] ?? false,
  };
});

const probe = probeTarget.pipe(
  Effect.matchEffect({
    onFailure: (error) =>
      Effect.succeed(
        setupFailureVerdict(
          Match.value(error).pipe(
            Match.tag(
              "ProbeInputEmpty",
              ({ option }) => `setup: ${option} is empty`
            ),
            Match.orElse(({ _tag }) => `setup: ${_tag}`)
          )
        )
      ),
    onSuccess: (target) =>
      runSandboxRpcProbe(target).pipe(
        Effect.flatMap((verdict) =>
          target.emailPreferences && verdict.ok
            ? runEmailPreferencesProbe(target).pipe(
                Effect.map(
                  Result.match({
                    onSuccess: (emailPreferences) => ({
                      ...verdict,
                      emailPreferences,
                    }),
                    onFailure: (failure) => ({
                      ...verdict,
                      ok: false,
                      failures: [...verdict.failures, failure],
                    }),
                  })
                )
              )
            : Effect.succeed(verdict)
        )
      ),
  }),
  Effect.tap((verdict) => Console.log(JSON.stringify(verdict))),
  Effect.flatMap((verdict) =>
    verdict.ok
      ? Effect.void
      : Effect.fail(new ProbeVerdictFailed({ failures: verdict.failures }))
  )
);

// stdout carries only the verdict line. Causes can hold remote data, so stderr
// gets a fixed line and the verdict's redacted failures say what went wrong.
BunRuntime.runMain(
  probe.pipe(
    Effect.tapCause(() =>
      Console.error("sandbox-rpc-probe: failed; see the verdict on stdout")
    ),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, FetchHttpClient.layer))
  ),
  { disableErrorReporting: true }
);
