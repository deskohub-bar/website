import { Effect, Option, Schema } from "effect";
import { requireAdministratorAuthorization } from "@/features/administrators/server/administrator-authorization.server";
import { adminPassListInput } from "@/features/passes/admin/pass-list-contract";
import { adminPassReadsLayer } from "@/features/passes/admin/pass-page-data.server";
import { listAdminPasses } from "@/features/passes/admin/pass-reads";
import {
  CoworkPassesReleaseGate,
  CoworkPassesReleaseGateForRun,
} from "@/features/passes/backend/cowork-passes-release-gate";
import {
  defineWorkspaceRoute,
  WorkspaceRouteFailure,
} from "@/shared/backend/workspace-route";

const notFound = () =>
  new WorkspaceRouteFailure({
    statusCode: 404,
    publicMessage: "Not found.",
  });

const invalidSearch = () =>
  new WorkspaceRouteFailure({
    statusCode: 400,
    publicMessage: "Invalid pass search.",
  });

export const POST = defineWorkspaceRoute(
  {
    operation: "administration.passes-search",
    cancellation: "interrupt-on-disconnect",
    caller: "client",
  },
  Effect.fnUntraced(function* (request: Request) {
    yield* requireAdministratorAuthorization.pipe(Effect.mapError(notFound));
    const open = yield* CoworkPassesReleaseGate.isOpen.pipe(
      Effect.provide(CoworkPassesReleaseGateForRun)
    );
    if (!open) return yield* notFound();
    const body: unknown = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: invalidSearch,
    });
    const input = Schema.decodeUnknownOption(adminPassListInput)(body);
    if (Option.isNone(input)) return yield* invalidSearch();

    const result = yield* listAdminPasses(input.value).pipe(
      Effect.provide(adminPassReadsLayer),
      Effect.mapError(
        () =>
          new WorkspaceRouteFailure({
            statusCode: 503,
            publicMessage: "Pass search is unavailable.",
          })
      )
    );
    return Response.json(result, {
      headers: { "cache-control": "private, no-store", vary: "Cookie" },
    });
  })
);
