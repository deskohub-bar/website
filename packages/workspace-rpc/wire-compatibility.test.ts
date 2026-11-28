import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { Headers } from "effect/http";
import { Rpc, RpcMessage, RpcSerialization } from "effect/rpc";
import { readBaseline } from "./fixtures/baseline-reader";
import recorded from "./fixtures/wire-baseline.json";
import {
  CallerHeaders,
  CampaignUnsubscribeRejected,
  InvalidCallerHeaders,
  WorkspaceRpcSerialization,
  WorkspaceRpcs,
} from "./src";
import { encodeCallerHeaders } from "./src/caller";

const baseline: Readonly<Record<string, string>> = recorded;

const requestId = "17";
const baselineHeaders = {
  "x-deskohub-correlation-id": "72823c14-d2de-4a19-94ec-8b70ad590242",
  "x-deskohub-locale": "cs-CZ",
  "x-deskohub-client-address": "192.0.2.20",
  "x-deskohub-user-agent": "RGVza29odWIgV2lyZSBGaXh0dXJlLzEuMA",
} as const;
const caller = {
  correlationId: "72823c14-d2de-4a19-94ec-8b70ad590242",
  locale: "cs-CZ",
  clientAddress: Option.some("192.0.2.20"),
  userAgent: Option.some("Deskohub Wire Fixture/1.0"),
} as const;
const request = { token: "synthetic-campaign-token" };

const successValues = {
  "EmailPreferences.openPreferences": [
    { accessToken: "synthetic-management-access-token" },
  ],
  "EmailPreferences.unsubscribeOneClick": ["withdrawn", "unchanged"],
};

const failures = {
  rejected: new CampaignUnsubscribeRejected(),
  "invalid-caller": new InvalidCallerHeaders(),
};

type ExpectedExit =
  | {
      readonly _tag: "Success";
      readonly value: string | { readonly accessToken: string };
    }
  | { readonly _tag: "Failure"; readonly error: string };

interface WireSample {
  readonly name: string;
  readonly tag: string;
  readonly kind: Parameters<typeof readBaseline>[1];
  readonly encoded: Uint8Array;
  readonly expected: unknown;
  readonly readCandidate: (bytes: Uint8Array) => unknown;
}

type BinaryEnvelope = Extract<
  typeof RpcMessage.EncodedSchema.Type,
  { readonly _tag: "Request" | "Exit" }
>;

const binary = Schema.decodeUnknownSync(Schema.Uint8Array);

const getSamples = Effect.gen(function* () {
  const { makeUnsafe, codecFor } = yield* RpcSerialization.RpcSerialization;
  const candidateHeaders = Object.entries(yield* encodeCallerHeaders(caller));
  const samples: WireSample[] = [];

  const encode = <S extends Schema.Top & { readonly EncodingServices: never }>(
    schema: S
  ) => Schema.encodeUnknownSync(codecFor(schema));

  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S
  ) => Schema.decodeUnknownSync(codecFor(schema));

  const frame = (value: BinaryEnvelope) => binary(makeUnsafe().encode(value));

  for (const [tag, successes] of Object.entries(successValues)) {
    const rpc = WorkspaceRpcs.requests.get(tag);
    if (!rpc) throw new Error(`Missing RPC: ${tag}`);

    const decodeFrame = (bytes: Uint8Array) => {
      const parser = makeUnsafe();
      const midpoint = Math.floor(bytes.length / 2);
      const frames = [
        ...parser.decode(bytes.subarray(0, midpoint)),
        ...parser.decode(bytes.subarray(midpoint)),
      ];
      expect(frames).toHaveLength(1);
      const message = Schema.decodeUnknownSync(RpcMessage.EncodedSchema)(
        frames[0]
      );
      if (message._tag === "Request") {
        expect(
          Schema.decodeUnknownSync(CallerHeaders)(
            Headers.fromInput(message.headers)
          )
        ).toEqual({
          ...baselineHeaders,
          "x-deskohub-user-agent": Option.getOrThrow(caller.userAgent),
        });
        return {
          ...message,
          payload: decode(rpc.payloadSchema)(message.payload),
        };
      }
      if (message._tag !== "Exit") throw new Error("Expected an exit frame");
      const exit = decode(Rpc.exitSchema(rpc))(message.exit);
      return {
        _tag: message._tag,
        requestId: message.requestId,
        exit: Exit.isSuccess(exit)
          ? { _tag: "Success", value: exit.value }
          : {
              _tag: "Failure",
              error: Option.getOrThrow(Cause.findErrorOption(exit.cause))._tag,
            },
      };
    };

    const add = (
      name: string,
      kind: Parameters<typeof readBaseline>[1],
      encoded: WireSample["encoded"],
      expected: WireSample["expected"],
      readCandidate: (bytes: Uint8Array) => unknown
    ) => {
      samples.push({
        name: `${tag}/${name}`,
        tag,
        kind,
        encoded,
        expected,
        readCandidate,
      });
    };
    const payloadBytes = binary(encode(rpc.payloadSchema)(request));
    add("payload", "request-payload", payloadBytes, request, (bytes) =>
      decode(rpc.payloadSchema)(bytes)
    );
    const requestFrame = {
      _tag: "Request" as const,
      id: requestId,
      tag,
      headers: Object.entries(baselineHeaders),
      payload: request,
    };
    add(
      "request",
      "request-frame",
      frame({
        ...requestFrame,
        headers: candidateHeaders,
        payload: payloadBytes,
      }),
      requestFrame,
      decodeFrame
    );

    const addExit = (
      name: string,
      exit: Exit.Exit<unknown, unknown>,
      expectedExit: ExpectedExit
    ) => {
      const envelope = { _tag: "Exit" as const, requestId };
      add(
        `exit/${name}`,
        "exit-frame",
        frame({ ...envelope, exit: binary(encode(Rpc.exitSchema(rpc))(exit)) }),
        { ...envelope, exit: expectedExit },
        decodeFrame
      );
    };

    for (const [index, success] of successes.entries()) {
      add(
        `success/${index}`,
        "success",
        binary(encode(rpc.successSchema)(success)),
        success,
        (bytes) => decode(rpc.successSchema)(bytes)
      );
      addExit(`success/${index}`, Exit.succeed(success), {
        _tag: "Success",
        value: success,
      });
    }
    for (const [kind, error] of Object.entries(failures)) {
      const schema =
        kind === "rejected" ? rpc.errorSchema : InvalidCallerHeaders;
      add(
        `error/${kind}`,
        kind === "rejected" ? "rejected" : "invalid-caller",
        binary(encode(schema)(error)),
        { _tag: error._tag },
        (bytes) => ({ _tag: decode(schema)(bytes)._tag })
      );
      addExit(kind, Exit.fail(error), { _tag: "Failure", error: error._tag });
    }
  }
  return samples;
}).pipe(Effect.provide(WorkspaceRpcSerialization));

const samples = Effect.runSync(getSamples);

describe("Workspace RPC initial SchemaBinary contract", () => {
  test("has a baseline for every sample", () => {
    expect([...WorkspaceRpcs.requests.keys()].sort()).toEqual(
      Object.keys(successValues).sort()
    );
    expect(Object.keys(baseline).sort()).toEqual(
      samples.map(({ name }) => name).sort()
    );
  });

  for (const sample of samples) {
    test(sample.name, () => {
      const hex = baseline[sample.name];
      if (!hex) throw new Error(`Missing baseline: ${sample.name}`);
      expect(sample.readCandidate(Buffer.from(hex, "hex"))).toEqual(
        sample.expected
      );
      expect(readBaseline(sample.tag, sample.kind, sample.encoded)).toEqual(
        sample.expected
      );
    });
  }
});
