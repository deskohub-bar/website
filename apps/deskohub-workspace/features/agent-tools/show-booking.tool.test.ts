import "@/shared/testing/workspace-test-env";
import { describe, expect, test } from "bun:test";
import { Effect, type Schema } from "effect";
import { showBookingResultSchema } from "./show-booking.schema";

const { agentToolResultOf, makeAgentToolTestServices } = await import(
  "./agent-tools.test-utils"
);
const { CallableAgentTools } = await import("./agent-tool");
const { listOfferingsTool } = await import("./list-offerings.tool");
const { makeShowBookingTool } = await import("./show-booking.tool");

const showBooking = (
  args: Schema.Json,
  callable: ReadonlyArray<string> = ["show_booking"],
  admitsCheckout = true,
  services = makeAgentToolTestServices()
) =>
  makeShowBookingTool({ admitsCheckout })
    .call(args)
    .pipe(
      Effect.provideService(CallableAgentTools, new Set(callable)),
      Effect.provide(services.layer),
      Effect.runPromise
    )
    .then(agentToolResultOf(showBookingResultSchema));

describe("show_booking", () => {
  test("prefills an exact Team Table selection only while enabled", async () => {
    const selection = {
      family: "table",
      date: "2099-07-30",
      seats: 4,
      start_time: "09:15",
      end_time: "10:45",
    };
    await expect(showBooking(selection)).rejects.toMatchObject({
      details: { code: "unsupported_family" },
    });

    const result = await showBooking(
      selection,
      ["show_booking"],
      false,
      makeAgentToolTestServices({ teamTableEnabled: true, teamTableSizes: [4] })
    );
    expect(result.selection).toEqual(selection);
    expect(result.offerings).toContainEqual(
      expect.objectContaining({ family: "table", seats: 4 })
    );
    expect(result.booking_mode).toBe("reservation_page");
  });

  test("lets the view start a booking when the caller may call start_reservation", async () => {
    const result = await showBooking({}, ["show_booking", "start_reservation"]);

    expect(result.booking_mode).toBe("reserve");
  });

  test("hands off to the reservation page when start_reservation isn't callable", async () => {
    const result = await showBooking({}, ["show_booking", "get_quote"]);

    expect(result.booking_mode).toBe("reservation_page");
  });

  test("hands off to the reservation page where the client's directory admits no checkout, even when start_reservation is callable", async () => {
    const result = await showBooking(
      {},
      ["show_booking", "start_reservation"],
      false
    );

    expect(result.booking_mode).toBe("reservation_page");
  });

  test("lists the offerings list_offerings lists, in the requested locale", async () => {
    const [booking, listing] = await Promise.all([
      showBooking({ locale: "cs-CZ" }),
      listOfferingsTool
        .call({ locale: "cs-CZ" })
        .pipe(
          Effect.provide(makeAgentToolTestServices().layer),
          Effect.runPromise
        ),
    ]);

    expect(booking.locale).toBe("cs-CZ");
    expect({
      advertised_on: booking.advertised_on,
      offerings: booking.offerings,
    }).toEqual({
      advertised_on: listing.advertised_on,
      offerings: listing.offerings,
    });
  });

  test("echoes the prefilled choices without the locale", async () => {
    const result = await showBooking({
      family: "meeting-room",
      date: "2099-07-30",
      duration: "hour:4",
      start_time: "09:00",
      locale: "en-US",
    });

    expect(result.selection).toEqual({
      family: "meeting-room",
      date: "2099-07-30",
      duration: "hour:4",
      start_time: "09:00",
    });
  });

  test("rejects a malformed prefill as invalid input", async () => {
    await expect(showBooking({ date: "30.7.2099" })).rejects.toMatchObject({
      details: { code: "invalid_input", field: "date" },
    });
  });
});
