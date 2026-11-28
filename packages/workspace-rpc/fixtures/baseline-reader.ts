// The initial deployed contract uses Effect 4.1.4. Keep its reader on the
// baseline Effect version even when the main workspace upgrades Effect.
import { Cause, Effect, Exit, Option, Schema } from "effect-rpc-baseline";
import { RpcMessage, RpcSerialization } from "effect-rpc-baseline/rpc";

const Request = Schema.Struct({ token: Schema.String });
const OpenSuccess = Schema.Struct({ accessToken: Schema.NonEmptyString });
const OneClickSuccess = Schema.Literals(["withdrawn", "unchanged"]);
const Rejected = Schema.TaggedStruct("CampaignUnsubscribeRejected", {});
const InvalidCaller = Schema.TaggedStruct("InvalidCallerHeaders", {});
const Failure = Schema.Union([Rejected, InvalidCaller]);

export const readBaseline = Effect.runSync(
  Effect.gen(function* () {
    const { codecFor, makeUnsafe } = yield* RpcSerialization.RpcSerialization;

    return (
      tag: string,
      kind:
        | "request-payload"
        | "success"
        | "rejected"
        | "invalid-caller"
        | "request-frame"
        | "exit-frame",
      bytes: Uint8Array
    ): unknown => {
      const decode = <
        S extends Schema.Top & { readonly DecodingServices: never },
      >(
        schema: S
      ) => Schema.decodeUnknownSync(codecFor(schema));

      const success =
        tag === "EmailPreferences.openPreferences"
          ? OpenSuccess
          : OneClickSuccess;
      switch (kind) {
        case "request-payload":
          return decode(Request)(bytes);
        case "success":
          return decode(success)(bytes);
        case "rejected":
          return decode(Rejected)(bytes);
        case "invalid-caller":
          return decode(InvalidCaller)(bytes);
        case "request-frame":
        case "exit-frame": {
          const parser = makeUnsafe();
          const midpoint = Math.floor(bytes.length / 2);
          const frames = [
            ...parser.decode(bytes.subarray(0, midpoint)),
            ...parser.decode(bytes.subarray(midpoint)),
          ];
          if (frames.length !== 1)
            throw new Error("Expected one baseline frame");

          const message = Schema.decodeUnknownSync(RpcMessage.EncodedSchema)(
            frames[0]
          );
          if (message._tag === "Request") {
            return { ...message, payload: decode(Request)(message.payload) };
          }
          if (message._tag !== "Exit")
            throw new Error("Expected a baseline exit");
          const exit = decode(Schema.Exit(success, Failure, Schema.Defect()))(
            message.exit
          );
          return {
            _tag: message._tag,
            requestId: message.requestId,
            exit: Exit.isSuccess(exit)
              ? { _tag: "Success", value: exit.value }
              : {
                  _tag: "Failure",
                  error: Option.getOrThrow(Cause.findErrorOption(exit.cause))
                    ._tag,
                },
          };
        }
      }
    };
  }).pipe(Effect.provide(RpcSerialization.layerSchemaBinary()))
);
