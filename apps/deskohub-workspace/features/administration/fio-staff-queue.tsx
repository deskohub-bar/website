import type { Locale } from "@/features/i18n";
import { AdministrationLink } from "./admin-link";
import { administrationHref } from "./administration-href";
import { AdministrationDetailSection } from "./detail-components";
import { FioMovementEvidence } from "./fio-movement-evidence";
import {
  type FioStaffQueue,
  loadAdministrationFioQueue,
} from "./fio-settlement-page-data.server";
import { m } from "./i18n";
import { AdministrationAlert } from "./notice";

const fioQueueHref = (queue: FioStaffQueue, cursor?: string) =>
  `${administrationHref("/[locale]/admin/orders")}?fio=${queue}${cursor ? `&fioBefore=${encodeURIComponent(cursor)}` : ""}` as const;

const queueLabels = {
  refund_required: m.administrationFioRefundQueue,
  unmatched: m.administrationFioUnmatchedQueue,
};

export function FioStaffQueueLinks({ locale }: { readonly locale: Locale }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
      <AdministrationLink
        className="font-semibold underline underline-offset-4"
        href={fioQueueHref("refund_required")}
      >
        {queueLabels.refund_required({}, { locale })}
      </AdministrationLink>
      <AdministrationLink
        className="font-semibold underline underline-offset-4"
        href={fioQueueHref("unmatched")}
      >
        {queueLabels.unmatched({}, { locale })}
      </AdministrationLink>
    </div>
  );
}

export async function FioRefundAttention({
  locale,
}: {
  readonly locale: Locale;
}) {
  const { movements } = await loadAdministrationFioQueue(
    "refund_required",
    undefined
  );
  if (!movements.length) {
    return (
      <div className="mb-6">
        <FioStaffQueueLinks locale={locale} />
      </div>
    );
  }

  return (
    <AdministrationAlert className="mb-6" status="warning">
      <p className="mb-1">
        {m.administrationFioRefundInstruction({}, { locale })}
      </p>
      <FioStaffQueueLinks locale={locale} />
    </AdministrationAlert>
  );
}

export async function FioStaffQueueContent({
  cursor,
  kind,
  locale,
}: {
  readonly cursor: string | undefined;
  readonly kind: FioStaffQueue;
  readonly locale: Locale;
}) {
  const { beforeId, movements, nextCursor } = await loadAdministrationFioQueue(
    kind,
    cursor
  );
  return (
    <>
      <h1 className="text-xl font-semibold">
        {queueLabels[kind]({}, { locale })}
      </h1>
      <FioStaffQueueLinks locale={locale} />
      {movements.length ? (
        <FioMovementEvidence
          locale={locale}
          movements={movements}
          source="queue"
        />
      ) : (
        <AdministrationDetailSection
          title={m.administrationFioMovements({}, { locale })}
        >
          <p className="text-sm">
            {m.administrationFioQueueEmpty({}, { locale })}
          </p>
        </AdministrationDetailSection>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <AdministrationLink
          className="font-semibold underline underline-offset-4"
          href={administrationHref("/[locale]/admin/orders")}
        >
          {m.administrationOrderListTitle({}, { locale })}
        </AdministrationLink>
        {beforeId && (
          <AdministrationLink
            className="font-semibold underline underline-offset-4"
            href={fioQueueHref(kind)}
          >
            {m.administrationFioNewestMovements({}, { locale })}
          </AdministrationLink>
        )}
        {nextCursor && (
          <AdministrationLink
            className="font-semibold underline underline-offset-4"
            href={fioQueueHref(kind, nextCursor)}
          >
            {m.administrationFioOlderMovements({}, { locale })}
          </AdministrationLink>
        )}
      </div>
    </>
  );
}
