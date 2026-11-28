import { CampaignUnsubscribeToken } from "@deskohub/workspace-rpc";
import { Rpc, RpcGroup } from "effect/rpc";
import { ProbeRejected } from "./probe-rpcs";

/** Creates a fresh, synthetic recipient in the sandbox instance's database. */
export class SandboxEmailPreferencesRpcs extends RpcGroup.make(
  Rpc.make("Probe.issueUnsubscribeToken", {
    payload: {},
    success: CampaignUnsubscribeToken,
    error: ProbeRejected,
  })
) {}
