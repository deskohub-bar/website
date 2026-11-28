import {
  AdministrationAuthentication,
  AdministrationInvoiceId,
  AdministrationReservationAccessGrant,
  CliAuthenticationRateLimited,
  CliBearerAuthentication,
  type CliClientCompatibility,
  CliGrantRejected,
  CliMutationInProgress,
  CliMutationRejected,
  CliMutationRequestId,
  type CliMutationRequestIdType,
  CliMutationUncertain,
  CliResourceNotFound,
  CliServiceUnavailable,
  CliSessionUnauthorized,
  CliStandaloneAccessCodeCleanupRequired,
  CliStandaloneAccessCodeReconciled,
  CurrentAdministrationCaller,
  CurrentCliSession,
  WorkspaceAdminApi,
} from "@deskohub/workspace-admin-api";
import { DateTime, Effect, Layer, Match, Redacted, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  StandaloneAccessCodeAdministration,
  type StandaloneAccessCodeCreationError,
} from "@/features/access-codes";
import {
  type InvoiceAdministrationListItem,
  InvoiceAdministrationService,
} from "@/features/accounting/admin/invoice-administration.service";
import { InvoiceAdministrationNotFoundError } from "@/features/accounting/admin/invoice-administration-identifier";
import type { InvoiceArchiveError } from "@/features/accounting/invoice-archive";
import type { InvoiceCancellationError } from "@/features/accounting/invoice-cancellation";
import { AdministrationService } from "@/features/administration/administration.service";
import { currentAdministrationProvenance } from "@/features/administration/administration-provenance";
import { AdministrationCustomerDirectory } from "@/features/administration/customer-directory.service";
import {
  getAdministrationOperationFilters,
  getAdministrationOrderDateTimeBounds,
  getAdministrationPaymentDateTimeBounds,
} from "@/features/administration/payment-administration-filters";
import {
  ReservationAccessAdministration,
  type ReservationAccessAdministrationError,
} from "@/features/administration/reservation-access-administration.service";
import {
  type ReservationAdministrationError,
  ReservationAdministrationService,
} from "@/features/administration/reservation-administration.service";
import {
  ReservationWithdrawalNotFoundError,
  retryReservationWithdrawal,
} from "@/features/administration/reservation-withdrawal";
import {
  AdministratorRoster,
  LegacyAdministratorBackfill,
} from "@/features/administrators";
import { AccountRoleGrants } from "@/features/administrators/backend/account-role-grants.service";
import {
  type AdminCustomerProfile,
  type AdminDiscountCode,
  type AdminDiscountCodeClaim,
  type AdminDiscountCodeDetail,
  type AdminVoucher,
  type AdminVoucherClaim,
  type AdminVoucherDetail,
  type DiscountAdminDashboard,
  DiscountAdministration,
} from "@/features/discounts/admin/discount-administration.service";
import { toAdminDotyposCustomer } from "@/features/discounts/admin/discount-administration-reads";
import {
  DiscountRequestLedger,
  makeDiscountOperations,
} from "@/features/discounts/admin/discount-operations.service";
import { isReservationProductTarget } from "@/features/discounts/product-target";
import { CampaignOperations } from "@/features/email-campaigns/backend/campaign-operations.service";
import { ReservationProductDetailsBackfill } from "@/features/reservation/backend/reservation-product-details-backfill.service";
import { getCurrentWorkspaceDate } from "@/features/reservation/reservation-date";
import {
  getReservationAccessName,
  type ReservationAccessGrant,
} from "@/features/reservation-access";
import { WithdrawalService } from "@/features/withdrawal/backend/withdrawal.service";
import { toWorkspaceWebHandler } from "@/shared/backend/workspace-effect";
import { AdministrationActionLog } from "./administration-action-log.service";
import { AdministrationActionRecordLive } from "./administration-action-record.server";
import {
  makeServiceUnavailable,
  mapAdministrationApiFailure,
  mapServiceFailure,
} from "./administration-api-failure";
import {
  reservationAccessRecovery,
  standaloneAccessCodeRecovery,
  standaloneAccessCodeStoredResult,
} from "./administration-mutation-recovery";
import {
  AdministrationRequestLedger,
  StoredResult,
} from "./administration-request-ledger.service";
import { AdminCliAdministratorsApiHandlers } from "./administrators-api.server";
import { invokeAsCliCaller } from "./cli-administration-operations.server";
import { CliAuthentication } from "./cli-authentication.service";
import { CliAuthenticationAdmission } from "./cli-authentication-admission.service";
import {
  administrationCallerSupportsTeamTable,
  CliClientCompatibilityLive,
  minimumDhwVersions,
} from "./cli-client-version";
import { cliDiscountRequestLedger } from "./cli-discount-request-ledger";
import { AdminCliAutomationsApiHandlers } from "./email-automations-api.server";
import { AdminCliCampaignsApiHandlers } from "./email-campaigns-api.server";

export const AdminCliApiHandlers = HttpApiBuilder.group(
  WorkspaceAdminApi,
  "cli",
  Effect.fn(function* (handlers) {
    const authentication = yield* CliAuthentication;
    const admission = yield* CliAuthenticationAdmission;
    return handlers
      .handle("getInfo", () =>
        Effect.succeed({
          apiVersion: "v1" as const,
          service: "deskohub-workspace" as const,
          minimumDhwVersions,
        })
      )
      .handle(
        "startAuthentication",
        Effect.fn(function* ({ payload }) {
          const allowed =
            yield* admission.isStartAllowed.pipe(mapServiceFailure);
          if (!allowed) {
            return yield* new CliAuthenticationRateLimited({
              message:
                "Too many CLI authentication requests were started. Try again shortly.",
            });
          }
          return yield* authentication.start(payload).pipe(mapServiceFailure);
        })
      )
      .handle("getAuthenticationStatus", ({ query }) =>
        authentication.status(query.code).pipe(mapServiceFailure)
      )
      .handle("exchangeGrant", ({ payload }) =>
        authentication
          .exchange(payload)
          .pipe(
            mapAdministrationApiFailure((cause) =>
              cause instanceof CliGrantRejected
                ? cause
                : makeServiceUnavailable()
            )
          )
      )
      .handle("getCurrentSession", () => CurrentCliSession);
  })
);

export const AdminCliAdministrationApiHandlers = HttpApiBuilder.group(
  WorkspaceAdminApi,
  "administration",
  Effect.fn(function* (handlers) {
    const administration = yield* AdministrationService;
    const reservationAdministration = yield* ReservationAdministrationService;
    const withdrawals = yield* WithdrawalService;
    const reservationAccess = yield* ReservationAccessAdministration;
    const authentication = yield* CliAuthentication;
    const discounts = yield* DiscountAdministration;
    const discountOperations = yield* makeDiscountOperations("reservations");
    const legacyDiscountOperations = yield* makeDiscountOperations(
      "reservations-before-team-table"
    );
    const customerDirectory = yield* AdministrationCustomerDirectory;
    const invoices = yield* InvoiceAdministrationService;
    const standaloneAccessCodes = yield* StandaloneAccessCodeAdministration;
    const ledger = yield* AdministrationRequestLedger;
    const productDetailsBackfill = yield* ReservationProductDetailsBackfill;
    return handlers
      .handle("getOverview", () =>
        Effect.all(
          {
            overview: administration
              .loadOverviewSource()
              .pipe(
                Effect.flatMap((source) => administration.loadOverview(source))
              ),
            refundsNeeded: administration.countReservationsNeedingRefund(),
          },
          { concurrency: "unbounded" }
        ).pipe(
          Effect.map(({ overview, refundsNeeded }) => ({
            ...overview,
            refundAttention: { unavailable: false, value: refundsNeeded },
          })),
          mapServiceFailure
        )
      )
      .handle("getReservationActivity", () =>
        administration.loadReservationActivity().pipe(mapServiceFailure)
      )
      .handle(
        "listReservations",
        Effect.fn(function* ({ query }) {
          const supportsTeamTable =
            yield* administrationCallerSupportsTeamTable;
          return yield* administration
            .listReservations({
              ...query,
              excludedType: supportsTeamTable ? undefined : "table",
            })
            .pipe(mapServiceFailure);
        })
      )
      .handle(
        "getReservationAudit",
        Effect.fn(function* ({ params, query }) {
          const { actor, source } = yield* currentAdministrationProvenance;
          const page = yield* reservationAdministration
            .readAudit({
              ...query,
              reservationId: params.reservationId,
              actor: { source, administrator: actor },
            })
            .pipe(mapServiceFailure);
          if (!page) {
            return yield* new CliResourceNotFound({
              message: "The reservation or its audit cursor was not found.",
            });
          }
          return page;
        })
      )
      .handle(
        "getReservation",
        Effect.fn(function* ({ params }) {
          const supportsTeamTable =
            yield* administrationCallerSupportsTeamTable;
          const detail = yield* administration
            .loadReservation(params.reservationId, {
              excludedType: supportsTeamTable ? undefined : "table",
            })
            .pipe(mapServiceFailure);
          if (!detail) {
            return yield* new CliResourceNotFound({
              message: "The reservation was not found.",
            });
          }
          if (!supportsTeamTable && detail.reservation.type === "table") {
            return yield* new CliServiceUnavailable({
              message:
                "This dhw version cannot read Team Table reservations. Run `dhw update`.",
            });
          }
          return {
            ...detail,
            invoice: detail.invoice && {
              ...detail.invoice,
              id: AdministrationInvoiceId.make(detail.invoice.id),
            },
          };
        })
      )
      .handle(
        "cancelReservation",
        Effect.fn(function* ({ params, payload }) {
          const { actor, source } = yield* currentAdministrationProvenance;
          return yield* reservationAdministration
            .cancel({
              actor: {
                source,
                administrator: actor,
              },
              ...(payload.confirmedConsequences && {
                confirmedConsequences: payload.confirmedConsequences,
              }),
              force: payload.force ?? false,
              reservationId: params.reservationId,
              sendCancellationEmail: payload.sendCancellationEmail,
            })
            .pipe(
              Effect.map(({ invoice, ...result }) => ({
                ...result,
                invoice: invoice && {
                  ...invoice,
                  invoiceId: AdministrationInvoiceId.make(invoice.invoiceId),
                },
              })),
              mapAdministrationApiFailure(mapReservationCancellationFailure)
            );
        })
      )
      .handle(
        "restoreReservation",
        Effect.fn(function* ({ params, payload }) {
          const { actor, source } = yield* currentAdministrationProvenance;
          return yield* reservationAdministration
            .restore({
              actor: { source, administrator: actor },
              acknowledgeRefundedPayment: payload.acknowledgeRefundedPayment,
              reservationId: params.reservationId,
              sendRestorationEmail: payload.sendRestorationEmail,
            })
            .pipe(
              Effect.map(({ invoice, ...result }) => ({
                ...result,
                invoice: invoice && {
                  ...invoice,
                  invoiceId:
                    invoice.invoiceId &&
                    AdministrationInvoiceId.make(invoice.invoiceId),
                },
              })),
              mapAdministrationApiFailure(mapReservationRestorationFailure)
            );
        })
      )
      .handle("retryReservationWithdrawal", ({ params }) =>
        retryReservationWithdrawal(params.reservationId).pipe(
          Effect.provideService(WithdrawalService, withdrawals),
          mapAdministrationApiFailure((cause) =>
            cause instanceof ReservationWithdrawalNotFoundError
              ? new CliResourceNotFound({
                  message: "The reservation has no customer withdrawal.",
                })
              : makeServiceUnavailable()
          )
        )
      )
      .handle("backfillReservationProductDetails", ({ payload }) =>
        productDetailsBackfill.runBatch(payload).pipe(mapServiceFailure)
      )
      .handle("mutateReservationAccess", ({ params, payload }) =>
        ledger
          .applyOnceWithEffects({
            requestId: payload.requestId,
            mutation: {
              kind: "reservation-access",
              reservationId: params.reservationId,
              mutation: payload.mutation,
            },
            stored: StoredResult.unchanged(
              AdministrationReservationAccessGrant
            ),
            apply: reservationAccess
              .mutate({
                reservationId: params.reservationId,
                ...payload.mutation,
              })
              .pipe(Effect.map(toCliReservationAccessGrant)),
            resume: reservationAccess
              .resumeInterruptedMutation(params.reservationId)
              .pipe(Effect.map(toCliReservationAccessGrant)),
            recovery: reservationAccessRecovery,
            inProgressMessage:
              "This reservation access mutation is still being applied. Retrying with the same request identifier is safe.",
          })
          .pipe(
            Effect.catchTag("ReservationAccessAdministrationError", (cause) =>
              Effect.fail(cause).pipe(
                mapAdministrationApiFailure(mapReservationAccessMutationFailure)
              )
            )
          )
      )
      .handle("findReservation", ({ query }) =>
        administration.findReservationId(query.identifier).pipe(
          Effect.map((reservationId) => ({ reservationId })),
          mapServiceFailure
        )
      )
      .handle("listBookings", ({ query }) =>
        administration
          .listBookings({
            date: query.date ?? getCurrentWorkspaceDate().toString(),
            page: query.page,
          })
          .pipe(mapServiceFailure)
      )
      .handle("getBooking", ({ params }) =>
        administration.loadBooking(params.bookingId).pipe(
          mapServiceFailure,
          Effect.flatMap((detail) =>
            detail
              ? Effect.succeed(detail)
              : new CliResourceNotFound({
                  message: "The booking was not found.",
                })
          )
        )
      )
      .handle("listOrders", ({ query }) => {
        const range = getAdministrationOrderDateTimeBounds(
          query.from,
          query.to
        );
        return administration
          .listOrders({
            fromTime: range.fromTime,
            toTime: range.toTime,
            maxRecords: 50,
          })
          .pipe(mapServiceFailure);
      })
      .handle("getOrder", ({ params }) =>
        administration.loadOrder(params.orderId).pipe(mapServiceFailure)
      )
      .handle("listOperations", ({ query }) => {
        const range = getAdministrationPaymentDateTimeBounds(
          query.from,
          query.to
        );
        const filters = getAdministrationOperationFilters(query);
        return administration
          .listOperations({
            fromTime: range.fromTime,
            toTime: range.toTime,
            maxRecords: 100,
            ...filters,
          })
          .pipe(mapServiceFailure);
      })
      .handle("getOperation", ({ params }) =>
        administration.loadOperation(params.operationId).pipe(mapServiceFailure)
      )
      .handle("listCustomers", ({ query }) =>
        administration.listCustomers(query).pipe(mapServiceFailure)
      )
      .handle("searchCustomers", ({ query }) =>
        Effect.all({
          search: customerDirectory.search(query.query),
          now: DateTime.nowAsDate,
        }).pipe(
          Effect.map(({ search: { kind, customers }, now }) => ({
            kind,
            customers: customers.map((customer) =>
              toAdminDotyposCustomer(customer, now)
            ),
          })),
          mapServiceFailure
        )
      )
      .handle(
        "getCustomer",
        Effect.fn(function* ({ params }) {
          const supportsTeamTable =
            yield* administrationCallerSupportsTeamTable;
          return yield* Effect.all(
            {
              activity: administration.loadCustomerActivity(params.customerId, {
                excludedType: supportsTeamTable ? undefined : "table",
              }),
              profile: discounts
                .loadCustomerProfile({
                  customerId: params.customerId,
                })
                .pipe(
                  Effect.map(toCliCustomerProfile),
                  Effect.catch(() => Effect.succeed(null))
                ),
            },
            { concurrency: "unbounded" }
          ).pipe(mapServiceFailure);
        })
      )
      .handle("getCustomerReservationActivity", ({ params }) =>
        administration
          .loadCustomerReservationActivity(params.customerId)
          .pipe(mapServiceFailure)
      )
      .handle(
        "listCustomerReservations",
        Effect.fn(function* ({ params, query }) {
          const supportsTeamTable =
            yield* administrationCallerSupportsTeamTable;
          return yield* administration
            .loadCustomerReservations({
              customerId: params.customerId,
              page: query.page,
              excludedType: supportsTeamTable ? undefined : "table",
            })
            .pipe(mapServiceFailure);
        })
      )
      .handle(
        "getDiscountDashboard",
        Effect.fn(function* () {
          const supportsTeamTable =
            yield* administrationCallerSupportsTeamTable;
          return yield* discounts.loadDashboard().pipe(
            Effect.map((dashboard) =>
              toCliDiscountDashboard(dashboard, supportsTeamTable)
            ),
            mapServiceFailure
          );
        })
      )
      .handle("listDiscountGroups", () =>
        discounts.listDiscountGroups().pipe(
          Effect.map((discountGroups) => ({ discountGroups })),
          mapServiceFailure
        )
      )
      .handle("getDiscountCode", ({ params }) =>
        discounts.loadCodeDetail({ codeId: params.codeId }).pipe(
          Effect.map(toCliDiscountCodeDetail),
          Effect.catchTag(
            "DiscountAdminNotFoundError",
            () =>
              new CliResourceNotFound({
                message: "The discount code was not found.",
              })
          ),
          mapAdministrationApiFailure((cause) =>
            cause instanceof CliResourceNotFound
              ? cause
              : makeServiceUnavailable()
          )
        )
      )
      .handle("getVoucher", ({ params }) =>
        discounts.loadVoucherDetail({ voucherId: params.voucherId }).pipe(
          Effect.map(toCliVoucherDetail),
          Effect.catchTag(
            "DiscountAdminNotFoundError",
            () =>
              new CliResourceNotFound({
                message: "The voucher was not found.",
              })
          ),
          mapAdministrationApiFailure((cause) =>
            cause instanceof CliResourceNotFound
              ? cause
              : makeServiceUnavailable()
          )
        )
      )
      .handle("listInvoices", ({ query }) =>
        invoices.list(query).pipe(
          Effect.map((page) => ({
            ...page,
            items: page.items.map(toV1Invoice),
          })),
          mapServiceFailure
        )
      )
      .handle("getInvoice", ({ params }) =>
        invoices
          .get(params.invoiceId, { includeArchived: true })
          .pipe(
            Effect.map(toV1Invoice),
            mapAdministrationApiFailure(mapInvoiceReadFailure)
          )
      )
      .handle("getInvoicePdf", ({ params }) =>
        invoices.getPdf(params.invoiceId, { includeArchived: true }).pipe(
          Effect.map(({ bytes }) => bytes),
          mapAdministrationApiFailure(mapInvoiceReadFailure)
        )
      )
      .handle("getInvoiceCorrectiveDocumentPdf", ({ params }) =>
        invoices
          .getCorrectiveDocumentPdf(params.invoiceId, { includeArchived: true })
          .pipe(
            Effect.map(({ bytes }) => bytes),
            mapAdministrationApiFailure(mapCorrectiveDocumentReadFailure)
          )
      )
      .handle("getInvoiceCreationDefaults", () =>
        invoices.getCreationDefaults().pipe(mapServiceFailure)
      )
      .handle(
        "previewInvoice",
        Effect.fn(function* ({ payload }) {
          const { actor, source } = yield* currentAdministrationProvenance;
          return yield* invoices
            .preview(payload, { source, administrator: actor })
            .pipe(mapAdministrationApiFailure(mapInvoicePreviewFailure));
        })
      )
      .handle(
        "createInvoice",
        Effect.fn(function* ({ payload }) {
          const { actor, source } = yield* currentAdministrationProvenance;
          return yield* invoices
            .create(payload, { source, administrator: actor })
            .pipe(mapAdministrationApiFailure(mapInvoiceMutationFailure));
        })
      )
      .handle(
        "createStandaloneAccessCode",
        Effect.fn(function* ({ payload }) {
          const provenance = yield* currentAdministrationProvenance;
          const requestId = Schema.decodeUnknownSync(CliMutationRequestId)(
            payload.attemptId
          );
          return yield* ledger.applyOnceWithEffects({
            requestId,
            mutation: {
              kind: "standalone-access-code",
              request: payload.input,
              ...(payload.providerCredentialRemovedAttemptId !== undefined && {
                providerCredentialRemovedAttemptId:
                  payload.providerCredentialRemovedAttemptId,
              }),
            },
            stored: standaloneAccessCodeStoredResult,
            apply: standaloneAccessCodes
              .create({
                attemptId: payload.attemptId,
                ...provenance,
                request: payload.input,
                providerCredentialRemovedAttemptId:
                  payload.providerCredentialRemovedAttemptId,
              })
              .pipe(
                mapAdministrationApiFailure((cause) =>
                  mapStandaloneAccessCodeCreationFailure(cause, requestId)
                )
              ),
            recovery: standaloneAccessCodeRecovery,
            inProgressMessage: standaloneAccessCodeInProgressMessage,
          });
        })
      )
      .handle("resendInvoice", ({ params }) =>
        invoices.retry(params.invoiceId).pipe(
          mapAdministrationApiFailure((cause) =>
            cause instanceof InvoiceAdministrationNotFoundError
              ? new CliResourceNotFound({
                  message: "The invoice was not found.",
                })
              : makeServiceUnavailable()
          )
        )
      )
      .handle(
        "cancelInvoice",
        Effect.fn(function* ({ params, payload }) {
          const { actor, source } = yield* currentAdministrationProvenance;
          return yield* invoices
            .cancel({
              invoiceId: params.invoiceId,
              actor: {
                source,
                administrator: actor,
              },
              confirmedCustomerNotice: payload.confirmedCustomerNotice,
              ...(payload.reservation && { reservation: payload.reservation }),
            })
            .pipe(mapAdministrationApiFailure(mapInvoiceCancellationFailure));
        })
      )
      .handle(
        "archiveInvoice",
        Effect.fn(function* ({ params }) {
          const { actor, source } = yield* currentAdministrationProvenance;
          return yield* invoices
            .archive({
              invoiceId: params.invoiceId,
              actor: {
                source,
                administrator: actor,
              },
            })
            .pipe(mapAdministrationApiFailure(mapInvoiceArchiveFailure));
        })
      )
      .handle(
        "listSessions",
        Effect.fn(function* () {
          const { actor } = yield* CurrentAdministrationCaller;
          return yield* authentication
            .listSessions(actor.accountId)
            .pipe(mapServiceFailure);
        })
      )
      .handle(
        "mutateDiscounts",
        Effect.fn(function* ({ payload }) {
          const supportsTeamTable =
            yield* administrationCallerSupportsTeamTable;
          const { mutation } = payload;
          const targetsTeamTable =
            mutation.kind === "update-discount" &&
            mutation.discount.products.some(({ kind }) => kind === "table");
          const operations =
            supportsTeamTable || targetsTeamTable
              ? discountOperations
              : legacyDiscountOperations;
          return yield* invokeAsCliCaller(
            operations.invoke("mutateDiscounts", mutation),
            DiscountRequestLedger,
            (caller) => cliDiscountRequestLedger(ledger, caller, payload)
          ).pipe(
            // The endpoint decoded the payload with the strict v1 schema.
            Effect.catchTag("CliInputInvalid", (invalid) => Effect.die(invalid))
          );
        })
      )
      .handle(
        "renameSession",
        Effect.fn(function* ({ params, payload }) {
          const { actor } = yield* CurrentAdministrationCaller;
          const changed = yield* authentication
            .renameSession({
              owner: actor.accountId,
              sessionId: params.sessionId,
              clientName: payload.clientName,
            })
            .pipe(mapServiceFailure);
          if (!changed) {
            return yield* new CliResourceNotFound({
              message: "The CLI session was not found.",
            });
          }
          return { changed };
        })
      )
      .handle(
        "revokeSession",
        Effect.fn(function* ({ params }) {
          const { actor } = yield* CurrentAdministrationCaller;
          const changed = yield* authentication
            .revoke({
              owner: actor.accountId,
              sessionId: params.sessionId,
            })
            .pipe(mapServiceFailure);
          return { changed };
        })
      );
  })
);

/** Authenticates a CLI session's bearer for `cli.getCurrentSession`. */
export const CliBearerAuthenticationLive = Layer.effect(
  CliBearerAuthentication,
  Effect.gen(function* () {
    const authentication = yield* CliAuthentication;
    return {
      bearer: (httpEffect, { credential }) =>
        authentication
          .authenticateSession(`Bearer ${Redacted.value(credential)}`)
          .pipe(
            mapAdministrationApiFailure((cause) =>
              cause instanceof CliSessionUnauthorized
                ? cause
                : makeServiceUnavailable()
            ),
            Effect.flatMap((session) =>
              Effect.provideService(httpEffect, CurrentCliSession, session)
            )
          ),
    } satisfies CliBearerAuthentication["Service"];
  })
);

/**
 * Authenticates a CLI session's bearer for an administration operation and
 * provides its caller: the session's approving administrator, on the CLI
 * session channel. The session and the grant are read on every request.
 */
export const CliSessionAdministrationAuthenticationLive = Layer.effect(
  AdministrationAuthentication,
  Effect.gen(function* () {
    const authentication = yield* CliAuthentication;
    return {
      bearer: (httpEffect, { credential }) =>
        authentication
          .authenticateSession(`Bearer ${Redacted.value(credential)}`)
          .pipe(
            Effect.flatMap((session) =>
              authentication.sessionAdministrator(session.id).pipe(
                Effect.map((actor) => ({
                  actor,
                  channel: {
                    _tag: "CliSession" as const,
                    sessionId: session.id,
                  },
                }))
              )
            ),
            mapAdministrationApiFailure((cause) =>
              cause instanceof CliSessionUnauthorized
                ? cause
                : makeServiceUnavailable()
            ),
            Effect.flatMap((caller) =>
              Effect.provideService(
                httpEffect,
                CurrentAdministrationCaller,
                caller
              )
            )
          ),
    } satisfies AdministrationAuthentication["Service"];
  })
);

type InvoiceAdministration = typeof InvoiceAdministrationService.Service;

// Released v1 clients validate a closed set of invoice sources.
const toV1Invoice = <
  Invoice extends Pick<InvoiceAdministrationListItem, "source">,
>(
  invoice: Invoice
) => ({
  ...invoice,
  source:
    invoice.source === "pass-purchase" ? ("legacy" as const) : invoice.source,
});

const mapInvoiceReadFailure = (
  cause: Effect.Error<ReturnType<InvoiceAdministration["get" | "getPdf"]>>
) =>
  Match.value(cause).pipe(
    Match.tag(
      "InvoiceAdministrationNotFoundError",
      () => new CliResourceNotFound({ message: "The invoice was not found." })
    ),
    Match.orElse(makeServiceUnavailable)
  );

const invoiceNotFound = () =>
  new CliResourceNotFound({ message: "The invoice was not found." });

/**
 * The invoice's documents can't be read, so nothing was changed; the code
 * tells it apart from an unavailable API.
 */
const invoiceDocumentUnavailable = () =>
  new CliServiceUnavailable({
    code: "document_unavailable",
    message:
      "The invoice's documents can't be read right now. Nothing was changed; try again later.",
  });

const mapInvoiceCancellationError = ({
  code,
  message,
}: InvoiceCancellationError) => {
  switch (code) {
    case "not_found":
      return invoiceNotFound();
    case "reservation_confirmation_required":
    case "confirmation_stale":
    case "reservation_cancellation_in_progress":
      return new CliMutationRejected({ code, message });
    case "document_unavailable":
      return invoiceDocumentUnavailable();
    case "persistence_failed":
      return makeServiceUnavailable();
  }
};

const mapInvoiceCancellationFailure = (
  cause: Effect.Error<ReturnType<InvoiceAdministration["cancel"]>>
) =>
  Match.value(cause).pipe(
    Match.tag("InvoiceAdministrationNotFoundError", invoiceNotFound),
    Match.tag("InvoiceCancellationError", mapInvoiceCancellationError),
    Match.tag(
      "ReservationAdministrationError",
      mapReservationCancellationFailure
    ),
    Match.orElse(makeServiceUnavailable)
  );

const mapInvoiceArchiveFailure = (
  cause: Effect.Error<ReturnType<InvoiceAdministration["archive"]>>
) =>
  Match.value(cause).pipe(
    Match.tag("InvoiceAdministrationNotFoundError", invoiceNotFound),
    Match.tag(
      "InvoiceArchiveError",
      ({ code, message }: InvoiceArchiveError) =>
        code === "not_cancelled"
          ? new CliMutationRejected({ code, message })
          : invoiceNotFound()
    ),
    Match.orElse(makeServiceUnavailable)
  );

const mapCorrectiveDocumentReadFailure = (
  cause: Effect.Error<
    ReturnType<InvoiceAdministration["getCorrectiveDocumentPdf"]>
  >
) =>
  Match.value(cause).pipe(
    Match.tag("InvoiceAdministrationNotFoundError", invoiceNotFound),
    Match.tag("InvoiceCancellationError", ({ code }) =>
      code === "document_unavailable"
        ? invoiceDocumentUnavailable()
        : makeServiceUnavailable()
    ),
    Match.orElse(makeServiceUnavailable)
  );

const mapInvoicePreviewFailure = (
  cause: Effect.Error<ReturnType<InvoiceAdministration["preview"]>>
) =>
  Match.value(cause).pipe(
    Match.tag(
      "InvoiceAdministrationCustomerError",
      "ManualInvoiceValidationError",
      ({ message }) => new CliMutationRejected({ message })
    ),
    Match.orElse(makeServiceUnavailable)
  );

const mapInvoiceMutationFailure = (
  cause: Effect.Error<ReturnType<InvoiceAdministration["create"]>>
) =>
  Match.value(cause).pipe(
    Match.tag(
      "InvoiceAdministrationInProgressError",
      ({ message, invoiceId }) =>
        new CliMutationInProgress({
          message,
          requestId: CliMutationRequestId.make(invoiceId),
        })
    ),
    Match.tag(
      "InvoiceAdministrationCustomerError",
      "ManualInvoiceConflictError",
      "ManualInvoiceValidationError",
      ({ message }) => new CliMutationRejected({ message })
    ),
    Match.orElse(makeServiceUnavailable)
  );

const standaloneAccessCodeInProgressMessage =
  "This standalone access-code creation is still being applied. Retrying with the same attempt identifier is safe.";

const mapStandaloneAccessCodeCreationFailure = (
  cause: StandaloneAccessCodeCreationError,
  requestId: CliMutationRequestIdType
) => {
  const cleanupTarget = cause.cleanupTarget;
  return Match.value(cause.outcome).pipe(
    Match.when("ambiguous", () =>
      cleanupTarget === undefined
        ? makeServiceUnavailable()
        : new CliMutationUncertain({
            message: `The standalone access-code creation outcome is ambiguous. Do not retry automatically; inspect the access code "${cleanupTarget.name}" (attempt ${cleanupTarget.attemptId}) in the Igloohome app over Bluetooth, or verify it is absent, then rerun with --provider-credential-removed ${cleanupTarget.attemptId} to reconcile.`,
          })
    ),
    Match.when("cleanup-required", () =>
      cleanupTarget === undefined
        ? makeServiceUnavailable()
        : new CliStandaloneAccessCodeCleanupRequired({
            message: `A previous attempt for this window is ambiguous. Inspect the access code "${cleanupTarget.name}" (attempt ${cleanupTarget.attemptId}) in the Igloohome app over Bluetooth, or verify it is absent, then rerun with --provider-credential-removed ${cleanupTarget.attemptId} to confirm the cleanup.`,
            cleanupTarget,
          })
    ),
    Match.when(
      "reconciled",
      () =>
        new CliStandaloneAccessCodeReconciled({
          message:
            "Your confirmed cleanup was recorded for the earlier ambiguous attempt, which created no access code. Run the same command again to create the code.",
        })
    ),
    Match.when(
      "in-progress",
      () =>
        new CliMutationInProgress({
          message: standaloneAccessCodeInProgressMessage,
          requestId,
        })
    ),
    Match.when(
      "rejected",
      () => new CliMutationRejected({ message: cause.message })
    ),
    Match.when("unavailable", makeServiceUnavailable),
    Match.exhaustive
  );
};

const mapReservationCancellationFailure = (
  cause: ReservationAdministrationError
) => {
  if (cause.code === "not_found") {
    return new CliResourceNotFound({ message: cause.message });
  }
  if (cause.code === "not_cancellable") {
    return new CliMutationRejected({
      message: cause.message,
      ...(cause.reason === "confirmation_stale" && { code: cause.reason }),
    });
  }
  return makeServiceUnavailable();
};

/** A refusal over a refund keeps its message, which names the refunded amount. */
const mapReservationRestorationFailure = (
  cause: ReservationAdministrationError
) => {
  if (cause.code === "not_found") {
    return new CliResourceNotFound({ message: cause.message });
  }
  if (cause.code === "not_restorable") {
    return new CliMutationRejected({ message: cause.message });
  }
  return makeServiceUnavailable();
};

const mapReservationAccessMutationFailure = (
  cause: ReservationAccessAdministrationError
) =>
  Match.value(cause.reason).pipe(
    Match.when(
      "not_found",
      () => new CliResourceNotFound({ message: cause.message })
    ),
    Match.when(
      "invalid_state",
      () => new CliMutationRejected({ message: cause.message })
    ),
    Match.when("retryable_failure", makeServiceUnavailable),
    Match.when("recovery_failed", makeServiceUnavailable),
    Match.exhaustive
  );

const toCliReservationAccessGrant = (grant: ReservationAccessGrant) => ({
  id: grant.id,
  state: grant.state,
  provider: grant.provider,
  credentialType: grant.credentialType,
  deviceId: grant.deviceId,
  providerCredentialId: grant.providerCredentialId,
  accessName: getReservationAccessName(grant),
  scheduledStartsAt: grant.scheduledAccessStartsAt.toString(),
  startsAt: grant.accessStartsAt.toString(),
  endsAt: grant.accessEndsAt.toString(),
  provisioningStartedAt: grant.provisioningStartedAt?.toString() ?? null,
  issuedAt: grant.issuedAt?.toString() ?? null,
  failedAt: grant.failedAt?.toString() ?? null,
  failureCode: grant.failureCode,
  createdAt: grant.createdAt.toString(),
  updatedAt: grant.updatedAt.toString(),
});

const toCliCustomerProfile = (profile: AdminCustomerProfile) => ({
  ...profile,
  codes: profile.codes.map(toCliDiscountCode),
  claims: profile.claims.flatMap(toCliReservationClaim),
  vouchers: profile.vouchers.map(toCliVoucher),
  voucherClaims: profile.voucherClaims.flatMap(toCliReservationClaim),
});

const toCliDiscountCode = <Code extends AdminDiscountCode>(code: Code) => ({
  ...code,
  validFrom: code.validFrom?.toString() ?? null,
  validUntil: code.validUntil?.toString() ?? null,
  createdAt: code.createdAt.toString(),
  updatedAt: code.updatedAt.toString(),
});

/** v1 claims link to a reservation. Pass claims still count in code balances. */
const toCliReservationClaim = <
  Claim extends AdminDiscountCodeClaim | AdminVoucherClaim,
>(
  claim: Claim
) => {
  const { workspaceReservationId } = claim;
  if (workspaceReservationId === null) return [];

  return [
    {
      ...claim,
      workspaceReservationId,
      reservationExpiresAt: claim.reservationExpiresAt.toString(),
      reservedAt: claim.reservedAt.toString(),
      redeemedAt: claim.redeemedAt?.toString() ?? null,
      releasedAt: claim.releasedAt?.toString() ?? null,
    },
  ];
};

const toCliVoucher = <Voucher extends AdminVoucher>(voucher: Voucher) => ({
  ...voucher,
  validFrom: voucher.validFrom?.toString() ?? null,
  validUntil: voucher.validUntil?.toString() ?? null,
  createdAt: voucher.createdAt.toString(),
  updatedAt: voucher.updatedAt.toString(),
});

const toCliDiscountDashboard = (
  dashboard: DiscountAdminDashboard,
  supportsTeamTable: boolean
) => ({
  ...dashboard,
  discounts: dashboard.discounts.map((discount) => ({
    ...discount,
    products: discount.products
      .filter(isReservationProductTarget)
      .filter(({ kind }) => supportsTeamTable || kind !== "table"),
    createdAt: discount.createdAt.toString(),
    updatedAt: discount.updatedAt.toString(),
  })),
  codes: dashboard.codes.map(toCliDiscountCode),
  vouchers: dashboard.vouchers.map(toCliVoucher),
});

const toCliDiscountCodeDetail = (detail: AdminDiscountCodeDetail) => ({
  ...detail,
  code: toCliDiscountCode(detail.code),
  claims: detail.claims.flatMap(toCliReservationClaim),
});

const toCliVoucherDetail = (detail: AdminVoucherDetail) => ({
  ...detail,
  voucher: toCliVoucher(detail.voucher),
  claims: detail.claims.flatMap(toCliReservationClaim),
});

const noStore = HttpRouter.middleware(
  (effect) =>
    Effect.map(effect, (response) =>
      HttpServerResponse.setHeader(
        response,
        "Cache-Control",
        "private, no-store"
      )
    ),
  { global: true }
);

/**
 * The administration API's HTTP app, with the given authentication for its
 * operations, the given CLI session authentication for
 * `cli.getCurrentSession`, and the given client compatibility check. Each
 * call builds its own router, group handlers and global middleware: group
 * handlers capture the middleware they were built with, so instances sharing
 * the Workspace memo map must not share them. The domain services, and the action log
 * that records every state-changing operation, come from the caller.
 */
export const makeWorkspaceAdminApiLayer = <R, R2>({
  authentication,
  sessionAuthentication,
  clientCompatibility,
}: {
  readonly authentication: Layer.Layer<AdministrationAuthentication, never, R>;
  readonly sessionAuthentication: Layer.Layer<
    CliBearerAuthentication,
    never,
    R2
  >;
  readonly clientCompatibility: Layer.Layer<CliClientCompatibility>;
}) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(WorkspaceAdminApi).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.fresh(AdminCliApiHandlers),
          Layer.fresh(AdminCliAdministrationApiHandlers),
          Layer.fresh(AdminCliCampaignsApiHandlers),
          Layer.fresh(AdminCliAutomationsApiHandlers),
          Layer.fresh(AdminCliAdministratorsApiHandlers)
        )
      ),
      Layer.provide(
        Layer.mergeAll(
          sessionAuthentication,
          authentication,
          clientCompatibility,
          AdministrationActionRecordLive
        )
      )
    ),
    Layer.fresh(noStore)
  ).pipe(
    // Overrides the router `HttpRouter.toWebHandler` provides, which the
    // memo map would share between instances.
    Layer.provideMerge(Layer.fresh(HttpRouter.layer))
  );

/** The Workspace services behind the administration API. */
export const provideWorkspaceAdminApiServices = <A, E, R>(
  layer: Layer.Layer<A, E, R>
) =>
  layer.pipe(
    Layer.provide(AdministrationService.Live),
    Layer.provide(ReservationAdministrationService.Live),
    Layer.provide(WithdrawalService.Live),
    Layer.provide(ReservationProductDetailsBackfill.Live),
    Layer.provide(AdministratorRoster.Live),
    Layer.provide(LegacyAdministratorBackfill.Live),
    Layer.provide(ReservationAccessAdministration.Live),
    Layer.provide(DiscountAdministration.Live),
    Layer.provide(AccountRoleGrants.Live),
    Layer.provide(AdministrationCustomerDirectory.Live),
    Layer.provide(InvoiceAdministrationService.Live),
    Layer.provide(StandaloneAccessCodeAdministration.Live),
    Layer.provide(AdministrationRequestLedger.Live),
    Layer.provide(AdministrationActionLog.Live),
    Layer.provide(CampaignOperations.Live),
    Layer.provide(CliAuthenticationAdmission.Default),
    Layer.provide(CliAuthentication.Live)
  );

export const handleWorkspaceAdminApiRequest = toWorkspaceWebHandler(
  provideWorkspaceAdminApiServices(
    makeWorkspaceAdminApiLayer({
      authentication: CliSessionAdministrationAuthenticationLive,
      sessionAuthentication: CliBearerAuthenticationLive,
      clientCompatibility: CliClientCompatibilityLive,
    })
  )
);
