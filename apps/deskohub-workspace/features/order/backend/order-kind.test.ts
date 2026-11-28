import { afterAll, beforeAll, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  connectUnreachableWorkspaceDatabase,
  type UnreachableWorkspaceDatabase,
} from "@/shared/testing/unreachable-workspace-database.test-utils";
import { findOrderKind } from "./order-kind";

let unreachable: UnreachableWorkspaceDatabase;
beforeAll(async () => {
  unreachable = await connectUnreachableWorkspaceDatabase();
});
afterAll(() => unreachable.pool.close());

test("reads a route value that is not an order ID as no order, without querying", async () => {
  // Every statement on this database fails, so a lookup would fail the test.
  const kind = await findOrderKind("not-an-order-id").pipe(
    Effect.provide(unreachable.database),
    Effect.runPromise
  );

  expect(kind).toBeUndefined();
});
