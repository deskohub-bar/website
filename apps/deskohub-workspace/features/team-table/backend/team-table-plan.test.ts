import { expect, test } from "bun:test";
import {
  DotyposCloudIdSchema,
  DotyposReservationIdSchema,
  type DotyposTable,
  DotyposTableIdSchema,
} from "@deskohub/dotypos";
import { Result } from "effect";
import { workspaceReservationIdSchema } from "@/features/reservation/persistence-contracts";
import { plainDateStringSchema } from "@/shared/utils/temporal";
import { planTeamTable, type TeamTableBooking } from "./team-table-plan";

const interval = (start: string, end: string) => ({
  startsAt: Temporal.Instant.from(start),
  endsAt: Temporal.Instant.from(end),
});

const window = interval("2026-11-28T10:00Z", "2026-11-28T11:00Z");
const now = Temporal.Instant.from("2026-11-27T10:00Z");

const table = (
  name: string,
  seats: number,
  teamTable = true
): DotyposTable => ({
  id: DotyposTableIdSchema.make(name),
  _cloudId: DotyposCloudIdSchema.make("cloud"),
  display: true,
  enabled: true,
  name,
  seats: String(seats),
  tags: teamTable
    ? ["cowork:open-space", "reservation:table"]
    : ["cowork:open-space"],
});

test("requires an exact size and picks the already-booked table at the exclusive end", () => {
  const clean = table("a-clean", 4);
  const booked = table("b-booked", 4);
  const larger = table("c-larger", 8);
  const bookings: TeamTableBooking[] = [
    {
      kind: "team-table",
      tableId: booked.id,
      interval: interval("2026-11-28T09:00Z", "2026-11-28T10:00Z"),
    },
  ];

  expect(
    planTeamTable({
      tables: [larger, clean, booked],
      bookings,
      window,
      now,
      seats: 4,
    })
  ).toEqual(Result.succeed({ tableId: booked.id, moves: [] }));
  expect(
    planTeamTable({ tables: [larger], bookings: [], window, now, seats: 4 })
  ).toEqual(Result.succeed(undefined));
  expect(
    planTeamTable({
      tables: [booked],
      bookings,
      window: interval("2026-11-28T09:59:59.999999Z", "2026-11-28T11:00Z"),
      now,
      seats: 4,
    })
  ).toEqual(Result.succeed(undefined));
});

const sourceIdentity = (id: string, date = "2026-11-28") => ({
  reservationId: workspaceReservationIdSchema.make(id),
  sourceReservationId: DotyposReservationIdSchema.make(id),
  serviceDate: plainDateStringSchema.make(date),
});

const moveSource = (
  target: DotyposTable,
  id: string,
  interval: { startsAt: Temporal.Instant; endsAt: Temporal.Instant },
  move: NonNullable<Extract<TeamTableBooking, { kind: "shared" }>["move"]> = {
    ...sourceIdentity(id),
    origin: "paid-single-day",
    status: "CONFIRMED",
  }
): TeamTableBooking => ({
  kind: "shared",
  tableId: target.id,
  interval,
  seats: 1,
  move,
});

test("repacking prefers ordinary, then occupied Team Tables, including newly assigned moves", () => {
  const source = table("source", 4);
  const empty = table("a-empty", 3);
  const occupied = table("b-occupied", 3);
  const ordinary = table("z-ordinary", 1, false);
  const blockers = [
    moveSource(source, "one", window),
    moveSource(source, "two", window),
  ];
  const existingHold = {
    kind: "shared",
    tableId: occupied.id,
    interval: window,
    seats: 1,
  } satisfies TeamTableBooking;
  const targetIds = (
    tables: readonly DotyposTable[],
    bookings: readonly TeamTableBooking[]
  ) =>
    Result.getOrThrow(
      planTeamTable({ tables, bookings, window, now, seats: 4 })
    )?.moves.map(({ targetTableId }) => targetTableId);

  expect(
    targetIds([source, empty, occupied, ordinary], [...blockers, existingHold])
  ).toEqual([ordinary.id, occupied.id]);
  expect(
    targetIds([source, empty, occupied], [...blockers, existingHold])
  ).toEqual([occupied.id, occupied.id]);
  const beforeWindow = interval("2026-11-28T09:00Z", "2026-11-28T10:00Z");
  expect(
    targetIds(
      [source, empty, occupied],
      [
        moveSource(source, "early", {
          startsAt: beforeWindow.startsAt,
          endsAt: window.endsAt,
        }),
        moveSource(source, "later", window),
        { kind: "team-table", tableId: empty.id, interval: beforeWindow },
      ]
    )
  ).toEqual([occupied.id, occupied.id]);
});

test("backtracks to fit every source over its entire interval and preserves NEW", () => {
  const target = table("team", 4);
  const first = table("a", 1, false);
  const second = table("b", 1, false);
  const third = table("c", 1, false);
  const early = interval("2026-11-28T08:00Z", "2026-11-28T12:00Z");
  const late = interval("2026-11-28T10:00Z", "2026-11-28T15:00Z");
  const bookings: TeamTableBooking[] = [
    moveSource(target, "a", late),
    moveSource(target, "b", early, {
      ...sourceIdentity("b"),
      origin: "entry-pack",
      status: "CONFIRMED",
    }),
    moveSource(target, "c", early, {
      ...sourceIdentity("c"),
      origin: "authorized-checkout",
      status: "NEW",
      expiresAt: Temporal.Instant.from("2026-11-27T10:10Z"),
    }),
    {
      kind: "team-table",
      tableId: second.id,
      interval: interval("2026-11-28T09:00Z", "2026-11-28T10:00Z"),
    },
    {
      kind: "team-table",
      tableId: third.id,
      interval: interval("2026-11-28T13:00Z", "2026-11-28T14:00Z"),
    },
  ];
  const tables = [first, second, third, target];
  const result = planTeamTable({ tables, bookings, window, now, seats: 4 });

  expect(result).toEqual(
    Result.succeed({
      tableId: target.id,
      moves: [
        {
          ...late,
          reservationId: "a",
          sourceReservationId: "a",
          targetTableId: second.id,
          serviceDate: "2026-11-28",
          status: "CONFIRMED",
        },
        {
          ...early,
          reservationId: "b",
          sourceReservationId: "b",
          targetTableId: first.id,
          serviceDate: "2026-11-28",
          status: "CONFIRMED",
        },
        {
          ...early,
          reservationId: "c",
          sourceReservationId: "c",
          targetTableId: third.id,
          serviceDate: "2026-11-28",
          status: "NEW",
        },
      ],
    })
  );
  expect(
    planTeamTable({
      tables: tables.toReversed(),
      bookings: bookings.toReversed(),
      window,
      now,
      seats: 4,
    })
  ).toEqual(result);
  expect(
    planTeamTable({
      tables: [first, third, target],
      bookings,
      window,
      now,
      seats: 4,
    })
  ).toEqual(Result.succeed(undefined));
});

test("avoids all moves before preferring to reuse an already-booked Team Table", () => {
  const booked = table("a-booked", 4);
  const clean = table("b-clean", 4);
  const destination = table("destination", 2, false);
  const bookings: TeamTableBooking[] = [
    {
      kind: "team-table",
      tableId: booked.id,
      interval: interval("2026-11-28T09:00Z", "2026-11-28T10:00Z"),
    },
    moveSource(booked, "move-from-booked", window),
  ];

  expect(
    planTeamTable({
      tables: [booked, clean, destination],
      bookings,
      window,
      now,
      seats: 4,
    })
  ).toEqual(Result.succeed({ tableId: clean.id, moves: [] }));

  bookings.push(moveSource(clean, "move-from-clean", window));
  expect(
    planTeamTable({
      tables: [booked, clean, destination],
      bookings,
      window,
      now,
      seats: 4,
    })
  ).toMatchObject({
    success: {
      tableId: booked.id,
      moves: [{ reservationId: "move-from-booked" }],
    },
  });

  bookings.push(moveSource(booked, "second-move-from-booked", window));
  expect(
    planTeamTable({
      tables: [booked, clean, destination],
      bookings,
      window,
      now,
      seats: 4,
    })
  ).toMatchObject({
    success: {
      tableId: clean.id,
      moves: [{ reservationId: "move-from-clean" }],
    },
  });
});

test("keeps unverified, expired and non-future blockers on their original table", () => {
  const target = table("team", 4);
  const destination = table("open-space", 4, false);
  const blockers: TeamTableBooking[] = [
    { kind: "shared", tableId: target.id, interval: window, seats: 1 },
    { kind: "unknown", tableId: target.id, interval: window },
    { kind: "unknown", tableId: target.id },
    moveSource(
      target,
      "sub-millisecond-start",
      interval("2026-11-28T09:00:00.000001Z", "2026-11-28T15:00Z")
    ),
    moveSource(
      target,
      "sub-millisecond-end",
      interval("2026-11-28T09:00Z", "2026-11-28T15:00:00.000001Z")
    ),
    moveSource(target, "expired", window, {
      ...sourceIdentity("expired"),
      origin: "authorized-checkout",
      status: "NEW",
      expiresAt: now,
    }),
  ];
  for (const blocker of blockers) {
    expect(
      planTeamTable({
        tables: [target, destination],
        bookings: [blocker],
        window,
        now,
        seats: 4,
      })
    ).toEqual(Result.succeed(undefined));
  }

  const blocker = moveSource(target, "today", window);
  for (const current of ["2026-11-27T23:00Z", "2026-11-29T10:00Z"]) {
    expect(
      planTeamTable({
        tables: [target, destination],
        bookings: [blocker],
        window,
        now: Temporal.Instant.from(current),
        seats: 4,
      })
    ).toEqual(Result.succeed(undefined));
  }
});

test("reuses one destination across midnight if it has seats at every instant", () => {
  const target = table("team", 4);
  const destination = table("destination", 2, false);
  const first = interval("2026-11-27T23:00Z", "2026-11-28T23:00Z");
  const second = interval("2026-11-28T23:00Z", "2026-11-29T16:00Z");
  const bookings: TeamTableBooking[] = [
    moveSource(target, "day-one", first),
    moveSource(target, "day-two", second, {
      ...sourceIdentity("day-two", "2026-11-29"),
      origin: "unlimited-pass",
      status: "CONFIRMED",
    }),
    {
      kind: "shared",
      tableId: destination.id,
      interval: interval("2026-11-28T06:00Z", "2026-11-28T07:00Z"),
      seats: 1,
    },
    {
      kind: "shared",
      tableId: destination.id,
      interval: interval("2026-11-28T07:00Z", "2026-11-28T08:00Z"),
      seats: 1,
    },
  ];
  const request = {
    tables: [target, destination],
    bookings,
    window: interval("2026-11-28T22:45Z", "2026-11-28T23:15Z"),
    now,
    seats: 4,
  };
  expect(planTeamTable(request)).toMatchObject({
    success: {
      tableId: target.id,
      moves: [
        { targetTableId: destination.id, serviceDate: "2026-11-28" },
        { targetTableId: destination.id, serviceDate: "2026-11-29" },
      ],
    },
  });
  bookings.push({
    kind: "team-table",
    tableId: destination.id,
    interval: interval("2026-11-29T15:00Z", "2026-11-29T15:15Z"),
  });
  expect(planTeamTable(request)).toEqual(Result.succeed(undefined));
});
