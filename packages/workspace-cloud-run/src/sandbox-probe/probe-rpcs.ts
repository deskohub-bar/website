// The RPC contract the sandbox probe image serves on POST /rpc and the hosted
// proof calls over SchemaBinary. PR 3 replaces the probe image with the real
// API image, which merges these RPCs into its own group in the sandbox stage.
import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";

/** The probe's deliberate typed failure, proving errors decode on the client. */
export class ProbeRejected extends Schema.TaggedError<ProbeRejected>()(
  "ProbeRejected",
  { reason: Schema.String }
) {}

/** The largest stream `Probe.count` agrees to emit. */
const maxProbeCount = 100;

export class SandboxProbeRpcs extends RpcGroup.make(
  Rpc.make("Probe.ingest", {
    payload: { marker: Schema.String },
    success: Schema.Struct({ markerSha256: Schema.String }),
  }),
  Rpc.make("Probe.fail", { payload: {}, error: ProbeRejected }),
  Rpc.make("Probe.count", {
    payload: {
      n: Schema.Int.check(
        Schema.isBetween({ minimum: 0, maximum: maxProbeCount })
      ),
    },
    success: Schema.Int,
    stream: true,
  })
) {}
