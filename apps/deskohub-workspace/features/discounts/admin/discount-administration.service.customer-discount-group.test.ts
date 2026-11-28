import "@/shared/polyfills/temporal";

import { describe, expect, mock, test } from "bun:test";
import {
  DotyposCloudIdSchema,
  type DotyposCustomer,
  type DotyposCustomerId,
  DotyposCustomerIdSchema,
  type DotyposDiscountGroup,
  type DotyposDiscountGroupId,
  DotyposDiscountGroupIdSchema,
  DotyposService,
} from "@deskohub/dotypos";
import { GoogleCalendarService } from "@deskohub/google-calendar";
import { Effect, Layer, Option } from "effect";
import {
  CalendarResourceConfig,
  salesCalendarIdSchema,
  workspaceLimitationsCalendarIdSchema,
} from "@/shared/backend/config/calendar-resource.config";
import { makeRecordingWorkspaceDatabase } from "@/shared/testing/workspace-recording-database.test-utils";
import { DiscountAdministration } from "./discount-administration.service";

const customerId = DotyposCustomerIdSchema.make("dotypos-customer");
const membersId = DotyposDiscountGroupIdSchema.make("members");
const group = (
  overrides: Partial<DotyposDiscountGroup> = {}
): DotyposDiscountGroup => ({
  id: membersId,
  name: "Members",
  discountPercent: "10",
  ...overrides,
});

const customer = (
  id: DotyposCustomerId,
  overrides: Partial<DotyposCustomer> = {}
): DotyposCustomer => ({
  id,
  _cloudId: DotyposCloudIdSchema.make("synthetic-cloud"),
  points: null,
  flags: "0",
  display: true,
  deleted: false,
  ...overrides,
});

const setDiscountGroup = async (input: {
  readonly discountGroupId: DotyposDiscountGroupId | null;
  readonly customer?: Partial<DotyposCustomer>;
  readonly groups?: readonly DotyposDiscountGroup[];
}) => {
  const recording = await makeRecordingWorkspaceDatabase();
  const getDiscountGroups = mock(() => Effect.succeed(input.groups ?? []));
  const setCustomerDiscountGroup = mock(() =>
    Effect.succeed(customer(customerId))
  );
  const result = await Effect.gen(function* () {
    const administration = yield* DiscountAdministration;
    return yield* administration.setCustomerDiscountGroup({
      customerId,
      discountGroupId: input.discountGroupId,
    });
  }).pipe(
    Effect.provide(
      DiscountAdministration.Default.pipe(
        Layer.provide(
          Layer.mergeAll(
            recording.layer,
            Layer.mock(GoogleCalendarService, {}),
            Layer.mock(DotyposService, {
              getCustomer: (id) =>
                Effect.succeed(Option.some(customer(id, input.customer))),
              getDiscountGroups,
              setCustomerDiscountGroup,
            }),
            Layer.mock(CalendarResourceConfig, {
              salesCalendarId: salesCalendarIdSchema.make("sales-calendar"),
              workspaceLimitationsCalendarId:
                workspaceLimitationsCalendarIdSchema.make(
                  "limitations-calendar"
                ),
            })
          )
        )
      )
    ),
    Effect.result,
    Effect.runPromise
  );

  return { getDiscountGroups, result, setCustomerDiscountGroup };
};

describe("DiscountAdministration customer discount group", () => {
  test("clears a customer's group without checking the groups", async () => {
    const outcome = await setDiscountGroup({
      discountGroupId: null,
      customer: { _discountGroupId: membersId },
    });

    expect(outcome.result._tag).toBe("Success");
    expect(outcome.getDiscountGroups).not.toHaveBeenCalled();
    expect(outcome.setCustomerDiscountGroup).toHaveBeenCalledWith(
      customerId,
      null
    );
  });

  test("keeps a customer already in the group unchanged", async () => {
    const outcome = await setDiscountGroup({
      discountGroupId: membersId,
      customer: { _discountGroupId: membersId },
    });

    expect(outcome.result._tag).toBe("Success");
    expect(outcome.getDiscountGroups).not.toHaveBeenCalled();
    expect(outcome.setCustomerDiscountGroup).not.toHaveBeenCalled();
  });

  test("assigns an available group with an exact percentage", async () => {
    const outcome = await setDiscountGroup({
      discountGroupId: membersId,
      groups: [
        group({ id: DotyposDiscountGroupIdSchema.make("others") }),
        group(),
      ],
    });

    expect(outcome.result._tag).toBe("Success");
    expect(outcome.setCustomerDiscountGroup).toHaveBeenCalledWith(
      customerId,
      membersId
    );
  });

  test("rejects a missing, deleted, or hidden group without writing", async () => {
    for (const groups of [
      [group({ id: DotyposDiscountGroupIdSchema.make("others") })],
      [group({ deleted: true })],
      [group({ display: false })],
    ]) {
      const outcome = await setDiscountGroup({
        discountGroupId: membersId,
        groups,
      });

      expect(outcome.result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "DiscountAdminNotFoundError",
          resource: { kind: "Dotypos discount group", id: membersId },
        },
      });
      expect(outcome.setCustomerDiscountGroup).not.toHaveBeenCalled();
    }
  });

  test("rejects a group whose percentage Workspace can't apply", async () => {
    const outcome = await setDiscountGroup({
      discountGroupId: membersId,
      groups: [group({ discountPercent: "0" })],
    });

    expect(outcome.result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "InvalidDotyposDiscountPercentage",
        discountGroupId: membersId,
      },
    });
    expect(outcome.setCustomerDiscountGroup).not.toHaveBeenCalled();
  });

  test("rejects a deleted customer before touching the groups", async () => {
    const outcome = await setDiscountGroup({
      discountGroupId: membersId,
      customer: { deleted: true },
      groups: [group()],
    });

    expect(outcome.result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "DiscountAdminNotFoundError",
        resource: { kind: "Dotypos customer", id: customerId },
      },
    });
    expect(outcome.getDiscountGroups).not.toHaveBeenCalled();
    expect(outcome.setCustomerDiscountGroup).not.toHaveBeenCalled();
  });
});
