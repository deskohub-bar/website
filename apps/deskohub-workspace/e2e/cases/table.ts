import { Effect } from "effect";
import { HttpClient } from "effect/http";
import {
  getTableBaseAmount,
  getTableUsageAmount,
} from "@/features/checkout/table-product-catalog";
import { formatReservationDisplayDateTimeRange } from "@/features/reservation/reservation-date";
import { getTableReservationDurationMinutes } from "@/features/reservation/table-reservation-time";
import { formatMoney, moneyWithValue } from "@/shared/money/money";
import type { WorkspaceE2EDateAllocation } from "../allocation";
import {
  activateElement,
  assertPageCheck,
  normalizeBrowserText,
  waitForPageCondition,
  waitForPageText,
  waitForPageUrl,
  waitForReactHandler,
} from "../browser";
import type { OpenE2EBrowserSession } from "../browser-session";
import type { WorkspaceE2EStepRunner } from "../case-runner";
import {
  loadTableSlots,
  makeTableCheckoutData,
  selectAvailableTableSlots,
  type TableCheckoutSlot,
} from "../checkout/data";
import { toReservationStep } from "../checkout/reservation-form-preparation";
import type { DatasourceConfig, WorkspaceE2EConfig } from "../config";
import {
  toWorkspaceE2EError,
  tryWorkspaceE2ESync,
  type WorkspaceE2EError,
} from "../errors";
import {
  loadDotyposTableSeatInventory,
  type ValidatedDotyposReservation,
} from "../integrations/dotypos";
import { pollUntil } from "../polling";
import { isPreviewPageAvailable } from "../preview-readiness";
import { bindCheckoutContact } from "../referrals/checkout";
import { assert, log, parseUrl } from "../runtime";
import {
  getWorkspaceE2ETableStatusAddedInvitee,
  workspaceE2ETableMinimumSeats,
  workspaceE2ETablePreferredSeats,
} from "../table";
import { workspaceE2EPollIntervalMs } from "../timeouts";
import type {
  CheckoutData,
  CheckoutFlowState,
  CheckoutRow,
  WorkspaceE2ECase,
} from "../types";
import { executeCheckoutFlow } from "./checkout";

export type TableE2EPreparation = {
  /** Whether only one assignable table exists for `slot.seats`, so holding it makes the slot unavailable. */
  readonly exclusiveForSingleTable?: boolean;
  // Held by the paid Team Table checkout.
  readonly slot: TableCheckoutSlot;
  // Never held: the reservation URL-state case only opens and edits the form
  // for it, so it stays apart from the paid date to remain available.
  readonly urlStateSlot: TableCheckoutSlot;
};

/**
 * Picks the seat size to exercise in E2E from the Dotypos inventory: prefers
 * 4 seats (so both checkout-time and post-confirmation invitees are tested),
 * falling back to the largest available size >= 2 seats.
 */
export const selectWorkspaceE2ETableSeats = (
  capacities: readonly number[]
): number => {
  const eligible = capacities.filter(
    (seats) => seats >= workspaceE2ETableMinimumSeats
  );
  if (eligible.includes(workspaceE2ETablePreferredSeats)) {
    return workspaceE2ETablePreferredSeats;
  }
  const largest = eligible.at(-1);
  assert(
    largest !== undefined,
    `No Team Table with at least ${workspaceE2ETableMinimumSeats} seats is configured in Dotypos`
  );
  return largest;
};

export const prepareTableE2E = (
  config: WorkspaceE2EConfig,
  datasourceConfig: DatasourceConfig,
  allocation: WorkspaceE2EDateAllocation
): Effect.Effect<
  TableE2EPreparation | undefined,
  WorkspaceE2EError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const pageAvailable = yield* isPreviewPageAvailable(
      config,
      "/en-US/reservation/table",
      "data-table-reservation-form"
    );
    if (!pageAvailable) {
      log(
        "Team Table checkout e2e skipped because the Team Table page is disabled"
      );
      return undefined;
    }

    const inventory = yield* loadDotyposTableSeatInventory(datasourceConfig);
    const seats = yield* tryWorkspaceE2ESync(
      "select Team Table seat size",
      () => selectWorkspaceE2ETableSeats(inventory.capacities)
    );
    const [slot, urlStateSlot] = yield* selectAvailableTableSlots(
      config,
      seats,
      2,
      allocation
    );
    return yield* tryWorkspaceE2ESync(
      "assign Team Table checkout slots",
      () => {
        assert(slot && urlStateSlot, "Team Table checkout slots missing");
        return {
          exclusiveForSingleTable:
            (inventory.tableCountBySeats[seats] ?? 0) === 1,
          slot,
          urlStateSlot,
        };
      }
    );
  });

export const makeTableE2ECases = ({
  config,
  datasourceConfig,
  flowStates,
  preparation,
}: {
  readonly config: WorkspaceE2EConfig;
  readonly datasourceConfig: DatasourceConfig;
  readonly flowStates: CheckoutFlowState[];
  readonly preparation: TableE2EPreparation | undefined;
}): Effect.Effect<
  readonly WorkspaceE2ECase[],
  WorkspaceE2EError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    if (!preparation) return [];

    const httpClient = yield* HttpClient.HttpClient;
    const initialData = makeTableCheckoutData(
      config.baseUrl,
      preparation.slot,
      "table-paid"
    );
    const addedInvitee = getWorkspaceE2ETableStatusAddedInvitee();

    const makeTablePaidCase = (
      data: CheckoutData,
      state: CheckoutFlowState
    ): WorkspaceE2ECase => {
      const checkoutInvitees = data.table?.checkoutInvitees ?? [];
      return {
        bindAccountContact: (contact) => {
          const boundData = bindCheckoutContact(data, contact);
          return makeTablePaidCase(boundData, { data: boundData });
        },
        checkoutStates: [state],
        execute: ({ openSeparateSession, openSession, runStep }) =>
          executeCheckoutFlow({
            openSeparateSession,
            config,
            data,
            datasourceConfig,
            expectedReservationInvitees: checkoutInvitees,
            flow: {
              id: "table-paid",
              toReservationPreparation: toReservationStep,
            },
            payPageSteps: () => [
              {
                execute: assertTablePayPage(config, data, openSession),
                id: "assert-table-pay-summary",
                timeoutMs: config.timeouts.uiTransition,
              },
              ...(preparation.exclusiveForSingleTable === false
                ? []
                : [
                    {
                      execute: assertHeldTableSlotUnavailable(
                        config,
                        data
                      ).pipe(
                        Effect.provideService(HttpClient.HttpClient, httpClient)
                      ),
                      id: "assert-held-table-slot-unavailable",
                      timeoutMs: config.timeouts.datasource,
                    },
                  ]),
            ],
            afterFulfillment: (orderId, dotyposReservation) =>
              assertTeamTablePostFulfillment({
                addedInvitee,
                checkoutInvitees,
                config,
                data,
                dotyposReservation,
                openSession,
                orderId,
                runStep,
              }),
            runStep,
            openSession,
            state,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.mapError((cause) =>
              toWorkspaceE2EError(
                "run paid Team Table checkout e2e case",
                cause
              )
            )
          ),
        id: "checkout-table-paid",
        timeoutMs: config.timeouts.checkoutCase,
      };
    };

    const initialState = trackCheckoutState(flowStates, initialData);
    return [makeTablePaidCase(initialData, initialState)];
  });

const assertTablePayPage = (
  config: WorkspaceE2EConfig,
  data: CheckoutData,
  openSession: OpenE2EBrowserSession
): Effect.Effect<void, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const table = yield* getTableSlot(data);
    const durationMinutes = getTableReservationDurationMinutes(table);
    const baseAmount = getTableBaseAmount(table.seats);
    const usageAmount = getTableUsageAmount(table.seats, durationMinutes);
    const totalAmount = moneyWithValue(
      baseAmount.value + usageAmount.value,
      baseAmount
    );
    const expectedTexts = [
      "Team Table base charge",
      `Team Table time charge · ${durationMinutes} min`,
      formatMoney(baseAmount, data.locale),
      formatMoney(usageAmount, data.locale),
      formatMoney(totalAmount, data.locale),
    ].map((text) => normalizeBrowserText(text));

    yield* waitForPageText({
      description: "Team Table pay summary",
      matches: (text) => {
        const normalized = normalizeBrowserText(text);
        return expectedTexts.every((expected) => normalized.includes(expected));
      },
      session: yield* openSession,
      timeoutMs: config.timeouts.uiTransition,
    });
    log("Team Table pay summary validated");
  });

const assertHeldTableSlotUnavailable = (
  config: WorkspaceE2EConfig,
  data: CheckoutData
): Effect.Effect<void, WorkspaceE2EError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const table = yield* getTableSlot(data);
    yield* pollUntil(
      loadTableSlots(config, table.date, table.seats).pipe(
        Effect.map((availability) => {
          const entry = availability.availableEndsByStart.find(
            (candidate) => candidate.startTime === table.startTime
          );
          const stillAvailable = entry?.endTimes.includes(table.endTime);
          return stillAvailable ? undefined : true;
        })
      ),
      {
        intervalMs: workspaceE2EPollIntervalMs.datasource,
        label: "held Team Table slot to become unavailable",
        timeoutMs: config.timeouts.datasource,
      }
    );
    log("Held Team Table slot is exclusively unavailable");
  });

const assertTeamTablePostFulfillment = ({
  addedInvitee,
  checkoutInvitees,
  config,
  data,
  dotyposReservation,
  openSession,
  orderId,
  runStep,
}: {
  readonly addedInvitee: string;
  readonly checkoutInvitees: readonly string[];
  readonly config: WorkspaceE2EConfig;
  readonly data: CheckoutData;
  readonly dotyposReservation: ValidatedDotyposReservation;
  readonly openSession: OpenE2EBrowserSession;
  readonly orderId: CheckoutRow["reservation_id"];
  readonly runStep: WorkspaceE2EStepRunner;
}): Effect.Effect<void, WorkspaceE2EError> =>
  Effect.gen(function* () {
    const expectedInviteesAfterAdd = [...checkoutInvitees, addedInvitee];
    const expectedCountAfterAdd = 1 + expectedInviteesAfterAdd.length;

    yield* runStep({
      execute: Effect.gen(function* () {
        const browser = yield* openSession;
        const addFormSelector = 'form[aria-label="Add invitee"]';
        yield* waitForReactHandler(browser, addFormSelector, "onSubmit", {
          timeoutMs: config.timeouts.uiTransition,
        });
        yield* assertPageCheck(
          browser,
          "assert Team Table attendees are add-only",
          findTableInviteeRemovalControlProblem,
          undefined,
          { timeoutMs: config.timeouts.browserAction }
        );
        yield* browser.use("fill Team Table status invitee email", (page) =>
          page
            .locator(`${addFormSelector} input[type="email"]`)
            .fill(addedInvitee, { timeout: config.timeouts.browserAction })
        );
        yield* activateElement(
          browser,
          `${addFormSelector} button[type="submit"]`,
          {
            timeoutMs: config.timeouts.browserAction,
          }
        );
        yield* waitForPageText({
          description: "Team Table added invitee confirmation",
          matches: (text) =>
            normalizeBrowserText(text).includes(
              `${addedInvitee} was added to the reservation.`
            ),
          session: browser,
          timeoutMs: config.timeouts.uiTransition,
        });
        yield* waitForPageCondition(
          browser,
          "Team Table status attendee list includes added invitee",
          hasTeamTableStatusAttendees,
          {
            count: expectedCountAfterAdd,
            invitees: expectedInviteesAfterAdd,
          },
          { timeoutMs: config.timeouts.uiTransition }
        );
        log("Team Table post-confirmation invitee addition validated");
      }),
      id: "add-table-status-invitee",
      timeoutMs: config.timeouts.uiTransition,
    });

    yield* runStep({
      execute: Effect.gen(function* () {
        const browser = yield* openSession;
        const expectedAccessPeriod = formatReservationDisplayDateTimeRange(
          dotyposReservation.reservedFrom,
          dotyposReservation.reservedUntil,
          data.locale
        );
        yield* activateElement(browser, "#checkout-status-access", {
          timeoutMs: config.timeouts.browserAction,
        });
        yield* waitForPageUrl({
          description: "Team Table access page",
          matches: (url) => {
            const parsed = parseUrl(url);
            return Boolean(
              parsed &&
                parsed.host === config.expectedHost &&
                parsed.pathname.endsWith(`/reservation/access/${orderId}`)
            );
          },
          session: browser,
          timeoutMs: config.timeouts.browserNavigation,
        });
        yield* waitForPageCondition(
          browser,
          "Team Table access code visible",
          hasReservationAccessCode,
          undefined,
          { timeoutMs: config.timeouts.uiTransition }
        );
        const expectedAccessTexts = [
          ...(dotyposReservation.assignedTableName
            ? [dotyposReservation.assignedTableName]
            : []),
          `Team Table booked for ${expectedAccessPeriod}.`,
        ].map((text) =>
          normalizeBrowserText(text).toLocaleLowerCase(data.locale)
        );
        yield* waitForPageText({
          description: "Team Table access details",
          matches: (text) => {
            const normalized = normalizeBrowserText(text).toLocaleLowerCase(
              data.locale
            );
            return expectedAccessTexts.every((expected) =>
              normalized.includes(expected)
            );
          },
          session: browser,
          timeoutMs: config.timeouts.uiTransition,
        });
        log("Team Table access page validated");
      }),
      id: "assert-table-access-page",
      timeoutMs: config.timeouts.browserNavigation,
    });
  });

const getTableSlot = (data: CheckoutData) =>
  tryWorkspaceE2ESync("read Team Table checkout slot", () => {
    assert(data.table, "Team Table checkout slot missing");
    return data.table;
  });

const trackCheckoutState = (
  flowStates: CheckoutFlowState[],
  data: CheckoutData
) => {
  const state: CheckoutFlowState = { data };
  flowStates.push(state);
  return state;
};

// The in-page functions below run in the browser, so they must not close over
// anything.

export const findTableInviteeRemovalControlProblem = (): string | null => {
  const people = document.querySelector("[data-office-status-people]");
  if (!people) return "Team Table status people list missing";
  for (const button of people.querySelectorAll("button, a")) {
    const label = [
      button.textContent ?? "",
      button.getAttribute("aria-label") ?? "",
    ]
      .join(" ")
      .trim();
    if (/\b(remove|delete)\b/i.test(label)) {
      return "Team Table status rendered an unexpected invitee removal control";
    }
  }
  return null;
};

export const hasTeamTableStatusAttendees = (expected: {
  readonly count: number;
  readonly invitees: readonly string[];
}): boolean => {
  const rows = Array.from(
    document.querySelectorAll("[data-office-status-people] > ul > li")
  );
  if (rows.length !== expected.count) return false;
  const labels = rows.map((row) => row.firstElementChild?.textContent?.trim());
  return expected.invitees.every((email) => labels.includes(email));
};

export const hasReservationAccessCode = (): boolean => {
  const access = document.querySelector("[data-reservation-access]");
  const code = access?.querySelector("[data-reservation-access-code]");
  return Boolean(code && (code.textContent ?? "").trim().length > 0);
};
