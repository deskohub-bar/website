import { describe, expect, test } from "bun:test";
import { baseLocale, supportedLocales } from "@deskohub/i18n/locale-registry";
import { formatMoney } from "@/shared/money/money";
import type { ReservationRestorationFailureReason } from "./reservation-administration-error";
import { getReservationRestorationErrorMessage } from "./reservation-error-messages";

type RestorationRefusal = ReservationRestorationFailureReason;

const restorationRefusalsByKey = {
  not_found: "not_found",
  invalid_state: "invalid_state",
  cancellation_in_progress: "cancellation_in_progress",
  superseded: "superseded",
  refund_acknowledgement_required: "refund_acknowledgement_required",
  refund_check_failed: "refund_check_failed",
  table_unavailable: "table_unavailable",
  changed_in_dotypos: "changed_in_dotypos",
  dotypos_failed: "dotypos_failed",
  access_uncertain: "access_uncertain",
  details_unavailable: "details_unavailable",
  record_failed: "record_failed",
} as const satisfies Record<RestorationRefusal, RestorationRefusal>;

const restorationRefusals: readonly RestorationRefusal[] = Object.values(
  restorationRefusalsByKey
);

describe("getReservationRestorationErrorMessage", () => {
  test.each(supportedLocales)(
    "gives every refusal its own message in %s",
    (locale) => {
      const messages = restorationRefusals.map((reason) =>
        getReservationRestorationErrorMessage(reason, locale)
      );

      for (const message of messages) expect(message.trim()).not.toBe("");
      expect(new Set(messages).size).toBe(restorationRefusals.length);
    }
  );

  test.each(supportedLocales.filter((locale) => locale !== baseLocale))(
    "translates every refusal in %s",
    (locale) => {
      for (const reason of restorationRefusals) {
        expect(getReservationRestorationErrorMessage(reason, locale)).not.toBe(
          getReservationRestorationErrorMessage(reason, baseLocale)
        );
      }
    }
  );

  test.each(supportedLocales)(
    "names the refunded amount, full or partial, when a refund blocks restoration in %s",
    (locale) => {
      const amount = { value: 25_000, exponent: 2, currency: "CZK" };
      const withoutAmount = getReservationRestorationErrorMessage(
        "refund_acknowledgement_required",
        locale
      );
      const [full, partial] = (["full", "partial"] as const).map((coverage) =>
        getReservationRestorationErrorMessage(
          "refund_acknowledgement_required",
          locale,
          { amount, coverage }
        )
      );

      for (const message of [full, partial]) {
        expect(message).toContain(formatMoney(amount, locale));
        expect(message).not.toBe(withoutAmount);
      }
      expect(full).not.toBe(partial);
    }
  );
});
