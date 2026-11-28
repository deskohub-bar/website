import "../../shared/polyfills/temporal";

import { afterEach, expect, setSystemTime, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import isEmail from "validator/lib/isEmail.js";
import { makeWorkspaceE2EDateAllocation } from "../allocation";
import type { WorkspaceE2EConfig } from "../config";
import { workspaceE2ERunIdSchema } from "../run-identifiers";
import { workspaceE2ETimeouts } from "../timeouts";
import {
  makeCoworkCheckoutData,
  makeTableCheckoutData,
  selectAvailableCoworkDates,
  selectAvailableMeetingRoomSlots,
  selectAvailableOfficeSlots,
  selectAvailableTableSlots,
  selectCoworkDates,
} from "./data";

afterEach(() => setSystemTime());

test("does not reuse checkout phone numbers in later monthly runs", () => {
  const makePhoneSet = (now: string) => {
    setSystemTime(new Date(now));

    return new Set(
      Array.from(
        { length: 100 },
        () =>
          makeCoworkCheckoutData("https://workspace.example.com", "2099-09-01")
            .phone
      )
    );
  };

  const julyPhones = makePhoneSet("2099-07-17T09:48:00.000Z");
  const augustPhones = makePhoneSet("2099-08-17T09:48:00.000Z");

  expect(julyPhones.size).toBe(100);
  expect(augustPhones.size).toBe(100);
  expect(julyPhones.intersection(augustPhones).size).toBe(0);
});

test("keeps generated emails valid for the longest checkout flow identifier", () => {
  const data = makeCoworkCheckoutData(
    "https://workspace.example.com",
    "2099-09-01",
    "payment-late-recovery-refund-required"
  );

  expect(isEmail(data.email)).toBe(true);
  expect(data.email.split("@")[0]?.length).toBeLessThanOrEqual(64);
});

test("loads availability through the provided HTTP client", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const requests: Request[] = [];
  const httpClientLayer = makeHttpClientLayer(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json({ unavailableDates: [null, 42] });
    }
  );

  const dates = await Effect.runPromise(
    selectAvailableCoworkDates(makeConfig(), 2).pipe(
      Effect.provide(httpClientLayer)
    )
  );

  expect(dates).toEqual(["2099-07-31", "2099-08-03"]);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(
    "https://deskohub-workspace-a1b2c3d4e-deskohub-bar.vercel.app/api/workspace/availability?entryTier=open-space&from=2099-07-31&to=2099-10-15"
  );
  expect(requests[0]?.headers.get("x-vercel-protection-bypass")).toBe(
    "test-protection-bypass"
  );
});

test("reports a malformed availability response as an E2E parse failure", async () => {
  const httpClientLayer = makeHttpClientLayer(async () =>
    Response.json({ unavailableDates: "2099-08-03" })
  );

  const result = await Effect.runPromise(
    selectAvailableCoworkDates(makeConfig(), 1).pipe(
      Effect.provide(httpClientLayer),
      Effect.result
    )
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "WorkspaceE2EError",
      operation: "parse workspace availability dates",
      message:
        "parse workspace availability dates failed: availability response missing unavailableDates",
    },
  });
});

test("loads only the deterministic allocation shard through availability", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const requests: Request[] = [];
  const httpClientLayer = makeHttpClientLayer(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json({ unavailableDates: [] });
    }
  );

  const dates = await Effect.runPromise(
    selectAvailableCoworkDates(makeConfig(), 1, {
      allocation: {
        fromOffsetDays: 40,
        shardCount: 3,
        shardIndex: 1,
        toOffsetDays: 65,
      },
    }).pipe(Effect.provide(httpClientLayer))
  );

  expect(dates).toEqual(["2099-08-27"]);
  expect(requests[0]?.url).toContain("from=2099-08-26&to=2099-09-20");
});

test("spreads sparse availability across deterministic allocation shards", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const candidateDates = Array.from({ length: 77 }, (_, index) => {
    const date = new Date("2099-07-17T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index + 14);
    return date.toISOString().slice(0, 10);
  });
  const availableDates = new Set(
    candidateDates
      .filter((date) => {
        const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
        return day !== 0 && day !== 6;
      })
      .slice(0, 18)
  );
  const unavailableDates = candidateDates.filter(
    (date) => !availableDates.has(date)
  );
  const httpClientLayer = makeHttpClientLayer(async () =>
    Response.json({ unavailableDates })
  );

  const datesByShard = await Promise.all(
    Array.from({ length: 3 }, (_, shardIndex) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const allocation = makeWorkspaceE2EDateAllocation({
            runId: workspaceE2ERunIdSchema.make(
              `sparse-availability-${shardIndex}`
            ),
            shardIndex,
          });
          const initialDates = yield* selectAvailableCoworkDates(
            makeConfig(),
            5,
            {
              allocation,
              maximumReservationsPerDate: 4,
            }
          );
          const discountDates = yield* selectAvailableCoworkDates(
            makeConfig(),
            16,
            {
              allocation,
              excludedDates: new Set(initialDates),
              maximumReservationsPerDate: 4,
            }
          );

          expect(initialDates).toHaveLength(5);
          expect(discountDates).toHaveLength(16);
          return [...initialDates, ...discountDates];
        }).pipe(Effect.provide(httpClientLayer))
      )
    )
  );

  for (const dates of datesByShard) {
    const counts = Map.groupBy(dates, (date) => date);
    expect(new Set(dates).size).toBe(6);
    expect(Math.max(...[...counts.values()].map(({ length }) => length))).toBe(
      4
    );
  }
  expect(new Set(datesByShard.flat()).size).toBe(18);
});

test("reports allocation capacity context before case construction", async () => {
  const exit = await Effect.runPromiseExit(
    selectCoworkDates(["2099-08-03"], 2, {
      allocation: {
        fromOffsetDays: 14,
        shardCount: 3,
        shardIndex: 0,
        toOffsetDays: 39,
      },
      selectionLabel: "Reserved Desk with monitor:2x27-qhd",
    })
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const message = String(Cause.squash(exit.cause));
    expect(message).toContain("Reserved Desk with monitor:2x27-qhd");
    expect(message).toContain("shard 1 of 3");
    expect(message).toContain("supported concurrency 3");
  }
});

test("selects non-overlapping meeting-room slots for every duration", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const requests: Request[] = [];
  let activeRequestCount = 0;
  let maximumActiveRequestCount = 0;
  const httpClientLayer = makeHttpClientLayer(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      activeRequestCount += 1;
      maximumActiveRequestCount = Math.max(
        maximumActiveRequestCount,
        activeRequestCount
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRequestCount -= 1;
      return Response.json({
        meetingRoomUnavailable: false,
        unavailableDates: [],
      });
    }
  );

  const slots = await Effect.runPromise(
    selectAvailableMeetingRoomSlots(makeConfig(), [
      { unit: "hour", amount: 1 },
      { unit: "hour", amount: 4 },
      { unit: "day", amount: 1 },
    ]).pipe(Effect.provide(httpClientLayer))
  );

  expect(
    slots.map(({ date, duration, startDateTime }) => ({
      date,
      duration,
      startDateTime,
    }))
  ).toEqual([
    {
      date: "2099-07-31",
      duration: { unit: "hour", amount: 1 },
      startDateTime: "2099-07-31T10:00",
    },
    {
      date: "2099-08-03",
      duration: { unit: "hour", amount: 4 },
      startDateTime: "2099-08-03T10:00",
    },
    {
      date: "2099-08-04",
      duration: { unit: "day", amount: 1 },
      startDateTime: "2099-08-04T00:00",
    },
  ]);
  expect(requests).toHaveLength(3);
  expect(maximumActiveRequestCount).toBe(3);
  expect(requests[0]?.url).toContain("kind=meeting-room");
  expect(requests[0]?.url).not.toContain("_tag");
  expect(requests[2]?.url).toContain("from=2099-08-04");
  expect(requests[2]?.url).toContain("to=2099-08-04");
  expect(requests[2]?.headers.get("x-vercel-protection-bypass")).toBe(
    "test-protection-bypass"
  );
});

test("keeps meeting-room dates disjoint across allocation shards", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const httpClientLayer = makeHttpClientLayer(async () =>
    Response.json({
      meetingRoomUnavailable: false,
      unavailableDates: [],
    })
  );

  const slotsByShard = await Promise.all(
    Array.from({ length: 3 }, (_, shardIndex) =>
      Effect.runPromise(
        selectAvailableMeetingRoomSlots(
          makeConfig(),
          [{ unit: "hour", amount: 1 }],
          makeWorkspaceE2EDateAllocation({
            runId: workspaceE2ERunIdSchema.make(`meeting-room-${shardIndex}`),
            shardIndex,
          })
        ).pipe(Effect.provide(httpClientLayer))
      )
    )
  );

  expect(new Set(slotsByShard.flat().map(({ date }) => date)).size).toBe(3);
});

test("selects disjoint multi-day office ranges across allocation shards", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const requests: Request[] = [];
  const httpClientLayer = makeHttpClientLayer(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json({
        officeUnavailable: false,
        unavailableDates: [],
      });
    }
  );

  const slotsByShard = await Promise.all(
    Array.from({ length: 3 }, (_, shardIndex) =>
      Effect.runPromise(
        selectAvailableOfficeSlots(
          makeConfig(),
          2,
          makeWorkspaceE2EDateAllocation({
            runId: workspaceE2ERunIdSchema.make(`office-${shardIndex}`),
            shardIndex,
          })
        ).pipe(Effect.provide(httpClientLayer))
      )
    )
  );
  const slots = slotsByShard.flat();
  const touchedDates = slots.flatMap(({ endsOn, startsOn }) => [
    startsOn,
    endsOn,
  ]);

  expect(new Set(touchedDates).size).toBe(touchedDates.length);
  expect(
    slots.every(
      ({ endsOn, startsOn }) =>
        Temporal.PlainDate.from(startsOn).add({ days: 1 }).toString() ===
          endsOn && endsOn <= "2099-08-17"
    )
  ).toBe(true);
  expect(slotsByShard.map((shardSlots) => shardSlots.length)).toEqual([
    2, 2, 2,
  ]);
  expect(requests).toHaveLength(6);
  expect(requests[0]?.url).toContain("kind=office");
  expect(requests[0]?.url).toContain("seats=2");
  expect(requests[0]?.headers.get("x-vercel-protection-bypass")).toBe(
    "test-protection-bypass"
  );
});

test("skips an unavailable office range before selecting the next owned range", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  let requestCount = 0;
  const httpClientLayer = makeHttpClientLayer(async () => {
    requestCount += 1;
    return Response.json({
      officeUnavailable: requestCount === 1,
      unavailableDates: [],
    });
  });

  const [slot] = await Effect.runPromise(
    selectAvailableOfficeSlots(makeConfig(), 1).pipe(
      Effect.provide(httpClientLayer)
    )
  );

  if (!slot) throw new Error("office slot was not selected");
  expect(requestCount).toBe(2);
  expect(slot.endsOn).toBe(
    Temporal.PlainDate.from(slot.startsOn).add({ days: 1 }).toString()
  );
});

test("rejects meeting-room slots that touch an unavailable date", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const requests: Request[] = [];
  const httpClientLayer = makeHttpClientLayer(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      const requestUrl = new URL(request.url);

      return Response.json({
        meetingRoomUnavailable: false,
        unavailableDates:
          requests.length === 1 ? [requestUrl.searchParams.get("to")] : [],
      });
    }
  );

  const slots = await Effect.runPromise(
    selectAvailableMeetingRoomSlots(makeConfig(), [
      { unit: "day", amount: 1 },
    ]).pipe(Effect.provide(httpClientLayer))
  );

  expect(requests).toHaveLength(2);
  expect(slots[0]?.startDateTime).toBe("2099-08-03T00:00");
});

test("fails meeting-room shard exhaustion with capacity context", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const httpClientLayer = makeHttpClientLayer(async () =>
    Response.json({
      meetingRoomUnavailable: false,
      unavailableDates: [],
    })
  );
  const exit = await Effect.runPromiseExit(
    selectAvailableMeetingRoomSlots(
      makeConfig(),
      [{ unit: "hour", amount: 1 }],
      {
        fromOffsetDays: 16,
        shardCount: 3,
        shardIndex: 0,
        toOffsetDays: 16,
      }
    ).pipe(Effect.provide(httpClientLayer))
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const message = String(Cause.squash(exit.cause));
    expect(message).toContain("reservation:meeting-room hour:1 slot");
    expect(message).toContain("shard 1 of 3");
    expect(message).toContain("supported concurrency 3");
  }
});

test("selects disjoint Team Table slots across allocation shards and prefers 10:00-12:00", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const requests: URL[] = [];
  const httpClientLayer = makeHttpClientLayer(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push(url);
      if (url.searchParams.get("mode") === "table-slots") {
        const date = url.searchParams.get("date") ?? "2099-07-31";
        const seats = Number(url.searchParams.get("seats") ?? "4");
        return Response.json({
          availableEndsByStart: [
            { startTime: "09:00", endTimes: ["10:00", "11:00"] },
            { startTime: "10:00", endTimes: ["11:00", "12:00"] },
          ],
          availableStarts: ["09:00", "10:00"],
          date,
          seats,
          slotMinutes: 15,
          usableFrom: "08:00",
          usableUntil: "20:00",
        });
      }
      return Response.json({ unavailableDates: [] });
    }
  );

  const slotsByShard = await Promise.all(
    Array.from({ length: 3 }, (_, shardIndex) =>
      Effect.runPromise(
        selectAvailableTableSlots(
          makeConfig(),
          4,
          2,
          makeWorkspaceE2EDateAllocation({
            runId: workspaceE2ERunIdSchema.make(`table-${shardIndex}`),
            shardIndex,
          })
        ).pipe(Effect.provide(httpClientLayer))
      )
    )
  );
  const allSlots = slotsByShard.flat();

  expect(new Set(allSlots.map(({ date }) => date)).size).toBe(6);
  expect(
    allSlots.every(
      ({ endTime, seats, startTime }) =>
        seats === 4 && startTime === "10:00" && endTime === "12:00"
    )
  ).toBe(true);
  expect(
    requests.some(
      (url) =>
        url.searchParams.get("kind") === "table" &&
        url.searchParams.get("mode") === "table-slots" &&
        url.searchParams.get("seats") === "4"
    )
  ).toBe(true);

  const firstSlot = allSlots[0];
  if (!firstSlot) throw new Error("Team Table slot was not selected");
  const checkout = makeTableCheckoutData(
    "https://workspace.example.com",
    firstSlot
  );
  expect(checkout.expectedReservationDetails).toEqual({
    durationMinutes: 120,
    kind: "table",
    seats: 4,
  });
  expect(checkout.table?.checkoutInvitees).toHaveLength(1);
});

test("falls back to an open >=60-minute Team Table slot when 10:00-12:00 is unavailable", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const httpClientLayer = makeHttpClientLayer(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.searchParams.get("mode") === "table-slots") {
        const date = url.searchParams.get("date") ?? "2099-07-31";
        return Response.json({
          availableEndsByStart: [
            { startTime: "13:00", endTimes: ["13:30", "14:00"] },
          ],
          availableStarts: ["13:00"],
          date,
          seats: 2,
          slotMinutes: 15,
          usableFrom: "08:00",
          usableUntil: "20:00",
        });
      }
      return Response.json({ unavailableDates: [] });
    }
  );

  const [slot] = await Effect.runPromise(
    selectAvailableTableSlots(makeConfig(), 2, 1).pipe(
      Effect.provide(httpClientLayer)
    )
  );
  if (!slot) throw new Error("Team Table slot was not selected");
  expect(slot).toMatchObject({
    endTime: "14:00",
    seats: 2,
    startTime: "13:00",
  });
  expect(
    makeTableCheckoutData("https://workspace.example.com", slot).table
      ?.checkoutInvitees
  ).toEqual([]);
});

test("fails Team Table shard exhaustion with capacity context", async () => {
  setSystemTime(new Date("2099-07-17T09:48:00.000Z"));
  const httpClientLayer = makeHttpClientLayer(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (url.searchParams.get("mode") === "table-slots") {
        return Response.json({
          availableEndsByStart: [],
          availableStarts: [],
          date: url.searchParams.get("date") ?? "2099-08-03",
          seats: 4,
          slotMinutes: 15,
          usableFrom: "08:00",
          usableUntil: "20:00",
        });
      }
      return Response.json({ unavailableDates: [] });
    }
  );

  const exit = await Effect.runPromiseExit(
    selectAvailableTableSlots(makeConfig(), 4, 2, {
      fromOffsetDays: 14,
      shardCount: 3,
      shardIndex: 0,
      toOffsetDays: 20,
    }).pipe(Effect.provide(httpClientLayer))
  );

  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const message = String(Cause.squash(exit.cause));
    expect(message).toContain("reservation:table slots for 4 seats");
    expect(message).toContain("shard 1 of 3");
    expect(message).toContain("supported concurrency 3");
  }
});

const makeHttpClientLayer = (
  fetchImplementation: (
    input: URL | RequestInfo,
    init?: RequestInit
  ) => Promise<Response>
) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(
        FetchHttpClient.Fetch,
        Object.assign(fetchImplementation, {
          preconnect: globalThis.fetch.preconnect,
        })
      )
    )
  );

const makeConfig = (): WorkspaceE2EConfig => ({
  baseUrl: "https://deskohub-workspace-a1b2c3d4e-deskohub-bar.vercel.app",
  bypassSecret: "test-protection-bypass",
  expectedHost: "deskohub-workspace-a1b2c3d4e-deskohub-bar.vercel.app",
  paymentProvider: "nexi",
  timeouts: workspaceE2ETimeouts,
});
