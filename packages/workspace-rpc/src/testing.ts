import { RpcTest } from "effect/rpc";
import { WorkspaceRpcs } from "./workspace-rpcs";

export const makeWorkspaceRpcTestClient = () =>
  RpcTest.makeClient(WorkspaceRpcs, {
    disableFatalDefects: true,
    flatten: true,
  });
