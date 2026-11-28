import "@/shared/testing/workspace-test-env";

import { describe, expect, test } from "bun:test";
import { DotyposDiscountGroupIdSchema } from "@deskohub/dotypos";
import { DotyposServiceMock } from "@deskohub/dotypos/backend/service.mock";
import { Effect } from "effect";
import { listDiscountGroups } from "./discount-groups";

describe("listDiscountGroups", () => {
  test("trims names and drops deleted groups and groups without an id", async () => {
    const id = DotyposDiscountGroupIdSchema.make;
    const getDiscountGroups = () =>
      Effect.succeed([
        { id: id("10"), name: " Zulu ", discountPercent: null, deleted: false },
        { id: id("2"), name: "   ", discountPercent: null, deleted: false },
        { id: id("3"), name: null, discountPercent: null, deleted: false },
        { name: "No ID", discountPercent: null, deleted: false },
        { id: id("4"), name: "Deleted", discountPercent: null, deleted: true },
      ]);
    const dotypos = DotyposServiceMock({
      getDiscountGroups,
    });

    const result = await Effect.runPromise(
      listDiscountGroups.pipe(Effect.provide(dotypos))
    );

    expect(result).toEqual([
      { id: id("10"), name: "Zulu" },
      { id: id("2"), name: null },
      { id: id("3"), name: null },
    ]);
  });
});
