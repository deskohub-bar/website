import type { RpcServer } from "effect/rpc";

export const workspaceRpcOptions = {
  path: "/rpc",
  protocol: "http",
  spanPrefix: "WorkspaceRpc",
  disableFatalDefects: true,
} satisfies Pick<
  Parameters<typeof RpcServer.layerHttp>[0],
  "path" | "protocol" | "spanPrefix" | "disableFatalDefects"
>;
