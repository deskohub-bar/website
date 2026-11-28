import { describe, expect, test } from "bun:test";
import type { ReservationFormData } from "../schemas/reservation";
import { trainingReservationConfirmationUrl } from "./confirmation-url";

const confirmationPath = "/training-room/reservation/confirmation";

const reservation = (
  overrides: Partial<ReservationFormData> = {}
): ReservationFormData => ({
  firstName: "",
  lastName: "",
  company: "",
  role: "",
  email: "jana@example.test",
  phone: "+420 777 123 456",
  date: new Date("2026-11-20T09:00:00.000Z"),
  time: "10:00",
  duration: 3,
  specialRequirements: "",
  ...overrides,
});

const queryOf = (url: string) => {
  const [path, query] = url.split("?");
  const params = new URLSearchParams(query);
  return { path, params: Object.fromEntries(params), entryCount: params.size };
};

describe("trainingReservationConfirmationUrl", () => {
  test("carries every filled field to the confirmation page", () => {
    const url = trainingReservationConfirmationUrl(
      reservation({
        company: "Acme & Co",
        firstName: "Jana",
        lastName: "Nováková",
        role: "HR",
        specialRequirements: "Projector: a=b&c d",
      })
    );

    expect(queryOf(url)).toEqual({
      path: confirmationPath,
      entryCount: 10,
      params: {
        company: "Acme & Co",
        firstName: "Jana",
        lastName: "Nováková",
        role: "HR",
        email: "jana@example.test",
        phone: "+420 777 123 456",
        date: "2026-11-20T09:00:00.000Z",
        time: "10:00",
        duration: "3",
        specialRequirements: "Projector: a=b&c d",
      },
    });
  });

  test("leaves empty optional fields out of the query", () => {
    expect(
      queryOf(
        trainingReservationConfirmationUrl(reservation({ company: "Acme" }))
      )
    ).toEqual({
      path: confirmationPath,
      entryCount: 6,
      params: {
        company: "Acme",
        email: "jana@example.test",
        phone: "+420 777 123 456",
        date: "2026-11-20T09:00:00.000Z",
        time: "10:00",
        duration: "3",
      },
    });
  });
});
