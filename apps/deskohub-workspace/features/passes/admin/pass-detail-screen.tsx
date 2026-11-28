import type { DotyposTableId } from "@deskohub/dotypos";
import type { ReactNode } from "react";
import { AdministrationLink } from "@/features/administration/admin-link";
import { administrationHref } from "@/features/administration/administration-href";
import {
  AdministrationDetailSection,
  AdministrationFact,
} from "@/features/administration/detail-components";
import {
  formatAdministrationDateTime,
  formatAdministrationPlainDate,
} from "@/features/administration/formatters";
import { m } from "@/features/administration/i18n";
import { NexiOrderLink } from "@/features/administration/nexi-order-link";
import { AdministrationPage } from "@/features/administration/page-frame";
import {
  getAdministrationPaymentAttemptStateLabel,
  getRefundAmountDue,
} from "@/features/administration/payment-presentation";
import { AdministrationTableFrame } from "@/features/administration/table-frame";
import { getWorkspaceProductMonitorTitle } from "@/features/checkout/product-catalog.i18n";
import type { Locale } from "@/features/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import { formatMoney, moneyWithValue } from "@/shared/money/money";
import { formatCount } from "@/shared/utils/number";
import { getPassTierName } from "../pass-offer.i18n";
import {
  PassAdministrationActions,
  PassAdministrationAudit,
} from "./pass-administration-actions.server";
import { loadAdminPass } from "./pass-page-data.server";
import {
  PassPartyName,
  PassStatusBadge,
  passPaidLabel,
  passProductTitle,
  passRemainingLabel,
  passValidityRange,
} from "./pass-presentation";
import type { AdminPassDetail } from "./pass-reads";
import { UnlimitedDayCalendar } from "./unlimited-day-calendar";

export async function AdminPassDetailScreen({
  params,
}: {
  readonly params: Promise<{ readonly passId: string }>;
}) {
  const [{ passId }, locale] = await Promise.all([params, getRequestLocale()]);
  const detail = await loadAdminPass(passId);
  return (
    <AdminPassDetailView
      detail={detail}
      locale={locale}
      actions={<PassAdministrationActions passId={passId} />}
      operatorAudit={
        <PassAdministrationAudit passId={passId} locale={locale} />
      }
    />
  );
}

type PassDetailProps = {
  readonly detail: AdminPassDetail & {
    readonly deskLabels: ReadonlyMap<DotyposTableId, string>;
  };
  readonly locale: Locale;
};

export function AdminPassDetailView({
  detail,
  locale,
  actions,
  operatorAudit,
}: PassDetailProps & {
  readonly actions?: ReactNode;
  readonly operatorAudit?: ReactNode;
}) {
  const { pass } = detail;
  const purchaseDateLabel = detail.paidAt ? m.passesOrderedAt : m.passesCreated;
  const tableId = pass.tier === "open-space" ? null : detail.days[0]?.tableId;
  const desk = tableId ? (detail.deskLabels.get(tableId) ?? tableId) : null;
  return (
    <AdministrationPage>
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="break-all font-mono text-xs text-navy-blue/70">
            {m.passesRecord({ id: pass.id }, { locale })}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl sm:text-4xl">
              {passProductTitle(pass, locale)}
            </h1>
            <PassStatusBadge status={pass.status} locale={locale} />
          </div>
          <p className="mt-2 text-sm text-navy-blue/70">
            {getPassTierName(pass.tier, locale)}
            {desk && (
              <>
                {" "}
                · {m.passesDesk({}, { locale })} {desk}
              </>
            )}
          </p>
        </div>
        {actions}
      </header>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <p className="font-semibold">{passRemainingLabel(pass, locale)}</p>
            <p className="text-navy-blue/70">
              {passValidityRange(pass, locale)}
            </p>
          </div>
          {pass.product === "entry-pack" ? (
            <EntryLedger detail={detail} locale={locale} />
          ) : (
            <UnlimitedDays detail={detail} locale={locale} />
          )}
          <PaymentAttempts detail={detail} locale={locale} />
          <PassAudit detail={detail} locale={locale} />
          {operatorAudit}
        </div>
        <aside className="space-y-5">
          <AdministrationDetailSection title={m.passesHolder({}, { locale })}>
            <div className="space-y-2">
              <PassPartyName party={pass.holder} locale={locale} />
              {pass.claimed !== null && (
                <div>
                  <StatusBadge tone={pass.claimed ? "positive" : "progress"}>
                    {(pass.claimed ? m.passesClaimed : m.passesUnclaimed)(
                      {},
                      { locale }
                    )}
                  </StatusBadge>
                </div>
              )}
            </div>
          </AdministrationDetailSection>
          {(detail.coffee || detail.monitor) && (
            <AdministrationDetailSection title={m.passesAddOns({}, { locale })}>
              {detail.coffee && <p>{m.passesCoffee({}, { locale })}</p>}
              {detail.monitor && (
                <p>{getWorkspaceProductMonitorTitle(detail.monitor, locale)}</p>
              )}
            </AdministrationDetailSection>
          )}
          <AdministrationDetailSection title={m.passesOrder({}, { locale })}>
            <dl className="space-y-4">
              {pass.buyer && (
                <AdministrationFact
                  label={m.passesBuyer({}, { locale })}
                  value={<PassPartyName party={pass.buyer} locale={locale} />}
                />
              )}
              {pass.paid && (
                <AdministrationFact
                  label={m.passesPaid({}, { locale })}
                  value={passPaidLabel(pass, locale)}
                />
              )}
              <AdministrationFact
                label={(pass.complimentary
                  ? m.passesGranted
                  : purchaseDateLabel)({}, { locale })}
                value={formatAdministrationDateTime(
                  (detail.paidAt ?? detail.createdAt).toString(),
                  locale
                )}
              />
            </dl>
          </AdministrationDetailSection>
          <Consent detail={detail} locale={locale} />
        </aside>
      </div>
    </AdministrationPage>
  );
}

function EntryLedger({ detail, locale }: PassDetailProps) {
  const { claims, pass } = detail;
  const claimLabels = {
    reserved: m.passesReserved,
    consumed: m.passesConsumed,
    released: m.passesReleased,
  };
  return (
    <>
      <div aria-hidden className="flex gap-1 rounded-lg">
        {Array.from(
          { length: pass.entryCount ?? 0 },
          (_, index) => index + 1
        ).map((entry) => (
          <span
            className={
              entry <= (pass.entriesLeft ?? 0)
                ? "h-2 grow rounded-sm bg-aquamarine-green/75"
                : "h-2 grow rounded-sm bg-navy-blue/15"
            }
            key={entry}
          />
        ))}
      </div>
      <PassDetailTable
        title={m.passesEntries({}, { locale })}
        headings={[
          m.passesDate({}, { locale }),
          m.passesReservation({}, { locale }),
          m.passesStatus({}, { locale }),
        ]}
        rows={claims.map((claim) => ({
          id: claim.reservationId,
          cells: [
            formatAdministrationPlainDate(claim.date, locale),
            <ReservationLink
              id={claim.reservationId}
              key="reservation"
              locale={locale}
            />,
            claimLabels[claim.status]({}, { locale }),
          ],
        }))}
      />
    </>
  );
}

function UnlimitedDays({ detail, locale }: PassDetailProps) {
  const dayLabels = {
    draft: m.administrationReservationStatusStarting,
    creating_hold: m.administrationReservationStatusInProgress,
    hold_expired: m.passesExpired,
    held: m.passesReserved,
    confirming: m.passesReserved,
    confirmed: m.administrationReservationStatusComplete,
    cancelling: m.administrationReservationStatusCancelling,
    cancelled: m.passesCancelled,
    cancellation_failed: m.administrationReservationStatusCancellationIssue,
  };
  return (
    <>
      <UnlimitedDayCalendar detail={detail} locale={locale} />
      {detail.days.length > 0 && (
        <details className="rounded-xl border border-navy-blue/10 bg-white">
          <summary className="cursor-pointer p-4 font-semibold">
            {m.passesShowReservations(
              { count: formatCount(detail.days.length, locale) },
              { locale }
            )}
          </summary>
          <div className="border-t border-navy-blue/10 p-4">
            <PassDetailTable
              title={m.passesDays({}, { locale })}
              headings={[
                m.passesDate({}, { locale }),
                m.passesDesk({}, { locale }),
                m.passesReservation({}, { locale }),
                m.passesStatus({}, { locale }),
              ]}
              rows={detail.days.map((day) => ({
                id: day.id,
                cells: [
                  day.date
                    ? formatAdministrationPlainDate(day.date, locale)
                    : "—",
                  day.tableId
                    ? (detail.deskLabels.get(day.tableId) ?? day.tableId)
                    : "—",
                  <ReservationLink
                    id={day.id}
                    key="reservation"
                    locale={locale}
                  />,
                  dayLabels[day.status]({}, { locale }),
                ],
              }))}
            />
          </div>
        </details>
      )}
      {detail.moves.length > 0 && (
        <PassDetailTable
          title={m.passesMoves({}, { locale })}
          headings={[
            m.passesDate({}, { locale }),
            m.passesDesk({}, { locale }),
            m.passesStatus({}, { locale }),
          ]}
          rows={detail.moves.map((move) => ({
            id: move.id,
            cells: [
              <>
                <p>
                  {move.date
                    ? formatAdministrationPlainDate(move.date, locale)
                    : "—"}
                </p>
                <p className="text-xs text-navy-blue/65">
                  {formatAdministrationDateTime(
                    move.requestedAt.toString(),
                    locale
                  )}
                </p>
              </>,
              m.passesMoveDesks(
                {
                  from:
                    detail.deskLabels.get(move.sourceTableId) ??
                    move.sourceTableId,
                  to:
                    detail.deskLabels.get(move.targetTableId) ??
                    move.targetTableId,
                },
                { locale }
              ),
              moveStatusLabel(move, locale),
            ],
          }))}
        />
      )}
    </>
  );
}

function moveStatusLabel(
  move: AdminPassDetail["moves"][number],
  locale: Locale
) {
  if (move.ambiguousAt) return m.passesMoveNeedsReview({}, { locale });
  if (move.attachedAt) return m.passesMoved({}, { locale });
  if (move.settledAt) return m.passesMoveClosed({}, { locale });
  return m.passesMoving({}, { locale });
}

function PaymentAttempts({ detail, locale }: PassDetailProps) {
  if (!detail.attempts.length) return null;
  return (
    <AdministrationDetailSection
      title={m.passesPaymentAttempts({}, { locale })}
    >
      <ul className="divide-y divide-navy-blue/10">
        {detail.attempts.map((attempt) => (
          <li
            key={attempt.id}
            className="flex flex-wrap justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 space-y-1">
              <p className="font-medium">
                {getAdministrationPaymentAttemptStateLabel(
                  attempt.state,
                  locale
                )}
              </p>
              <p className="text-sm text-navy-blue/70">
                {formatAdministrationDateTime(
                  attempt.createdAt.toString(),
                  locale
                )}
              </p>
              {attempt.provider === "nexi" && attempt.providerOrderId && (
                <p className="break-all text-sm">
                  <NexiOrderLink
                    locale={locale}
                    orderId={attempt.providerOrderId}
                  />
                </p>
              )}
            </div>
            <div className="space-y-1 text-sm">
              <p className="font-semibold">{formatMoney(attempt, locale)}</p>
              {attempt.refundState === "required" && (
                <p className="font-semibold text-burned-orange-ink">
                  {m.passesRefundDue(
                    {
                      amount: formatMoney(
                        getRefundAmountDue(
                          moneyWithValue(
                            attempt.refundTargetValue ?? attempt.value,
                            attempt
                          ),
                          attempt.refundedAmountValue
                        ),
                        locale
                      ),
                    },
                    { locale }
                  )}
                </p>
              )}
              {attempt.refundedAmountValue !== null && (
                <p>
                  {m.passesRefunded(
                    {
                      amount: formatMoney(
                        moneyWithValue(attempt.refundedAmountValue, attempt),
                        locale
                      ),
                    },
                    { locale }
                  )}
                  {attempt.refundedAt && (
                    <>
                      {" "}
                      ·{" "}
                      {formatAdministrationDateTime(
                        attempt.refundedAt.toString(),
                        locale
                      )}
                    </>
                  )}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </AdministrationDetailSection>
  );
}

function Consent({ detail, locale }: PassDetailProps) {
  if (!detail.consent.length) return null;
  return (
    <AdministrationDetailSection title={m.passesConsent({}, { locale })}>
      <ul className="space-y-3 text-sm">
        {detail.consent.map((item) => (
          <li className="space-y-1" key={item.id}>
            <p className="font-medium">
              {item.documentKey === "termsAndConditions"
                ? m.passesTerms({}, { locale })
                : item.documentPath}
            </p>
            <p className="text-navy-blue/70">
              {(item.accepted ? m.passesAccepted : m.passesDeclined)(
                {},
                { locale }
              )}
              {" · "}
              {formatAdministrationDateTime(item.acceptedAt.toString(), locale)}
            </p>
            {(item.acknowledgements?.entryPackEarlyStartRequested ||
              item.acknowledgements?.unlimitedPassEarlyStartRequested) && (
              <p>{m.passesEarlyStart({}, { locale })}</p>
            )}
          </li>
        ))}
      </ul>
    </AdministrationDetailSection>
  );
}

function PassAudit({ detail, locale }: PassDetailProps) {
  const { withdrawal } = detail;
  if (!withdrawal) return null;
  return (
    <AdministrationDetailSection title={m.passesAudit({}, { locale })}>
      <dl className="space-y-4">
        <AdministrationFact
          label={m.passesWithdrawalSubmitted({}, { locale })}
          value={formatAdministrationDateTime(
            withdrawal.submittedAt.toString(),
            locale
          )}
        />
        {withdrawal.cancelledAt && (
          <AdministrationFact
            label={m.passesWithdrawalCompleted({}, { locale })}
            value={formatAdministrationDateTime(
              withdrawal.cancelledAt.toString(),
              locale
            )}
          />
        )}
      </dl>
    </AdministrationDetailSection>
  );
}

function ReservationLink({
  id,
  locale,
}: {
  readonly id: WorkspaceReservationId;
  readonly locale: Locale;
}) {
  return (
    <AdministrationLink
      className="break-all underline decoration-navy-blue/25 underline-offset-2 hover:decoration-current"
      href={administrationHref("/[locale]/admin/reservations/[reservationId]", {
        reservationId: id,
      })}
      aria-label={`${m.passesReservation({}, { locale })} ${id}`}
    >
      #{id}
    </AdministrationLink>
  );
}

function PassDetailTable({
  title,
  headings,
  rows,
}: {
  readonly title: string;
  readonly headings: readonly string[];
  readonly rows: readonly {
    readonly id: string;
    readonly cells: readonly ReactNode[];
  }[];
}) {
  if (!rows.length) return null;
  return (
    <section>
      <h2 className="mb-3 text-xl">{title}</h2>
      <AdministrationTableFrame>
        <div className="overflow-x-auto">
          <table aria-label={title} className="w-full text-left text-sm">
            <thead className="bg-navy-blue/[0.035] text-navy-blue/70">
              <tr>
                {headings.map((heading) => (
                  <th
                    className="px-4 py-3 font-semibold"
                    key={heading}
                    scope="col"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr className="border-t border-navy-blue/10" key={row.id}>
                  {row.cells.map((cell, index) => (
                    <td className="px-4 py-3" key={headings[index]}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AdministrationTableFrame>
    </section>
  );
}
