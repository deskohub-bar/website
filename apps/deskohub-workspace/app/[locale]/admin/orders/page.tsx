import { Suspense } from "react";
import {
  AdministrationAlert,
  AdministrationPage,
  AdministrationTableCount,
  AdministrationTableToolbar,
} from "@/features/administration/components";
import { OrdersAdministrationFilterForm } from "@/features/administration/filter-forms";
import {
  FioStaffQueueContent,
  FioStaffQueueLinks,
} from "@/features/administration/fio-staff-queue";
import { m } from "@/features/administration/i18n";
import {
  AdministrationCollectionLoading,
  AdministrationCountLoading,
  AdministrationFiltersLoading,
} from "@/features/administration/loading";
import {
  type AdministrationSearchParams,
  loadAdministrationOrdersPage,
} from "@/features/administration/page-data.server";
import { OrderTable } from "@/features/administration/payment-tables";
import type { Locale } from "@/features/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { getSearchParam } from "@/shared/utils/search-params";

export default function OrdersAdministrationPage({
  searchParams,
}: {
  readonly searchParams: AdministrationSearchParams;
}) {
  return <OrdersAdministration searchParams={searchParams} />;
}

async function OrdersAdministration({
  searchParams,
}: {
  readonly searchParams: AdministrationSearchParams;
}) {
  const locale = await getRequestLocale();

  return (
    <AdministrationPage>
      <Suspense
        fallback={
          <AdministrationCollectionLoading
            label={m.administrationOrderListLoading({}, { locale })}
            columns={6}
          />
        }
      >
        <OrderAdministrationContent
          locale={locale}
          searchParams={searchParams}
        />
      </Suspense>
    </AdministrationPage>
  );
}

async function OrderAdministrationContent({
  locale,
  searchParams,
}: {
  readonly locale: Locale;
  readonly searchParams: AdministrationSearchParams;
}) {
  const query = await searchParams;
  const fio = getSearchParam(query, "fio");
  if (fio === "refund_required" || fio === "unmatched") {
    return (
      <div className="space-y-5">
        <FioStaffQueueContent
          cursor={getSearchParam(query, "fioBefore")}
          kind={fio}
          locale={locale}
        />
      </div>
    );
  }
  const { range, result } = loadAdministrationOrdersPage(searchParams);
  return (
    <>
      <h1 className="sr-only">
        {m.administrationOrderListTitle({}, { locale })}
      </h1>
      <div className="mb-5">
        <FioStaffQueueLinks locale={locale} />
      </div>
      <AdministrationTableToolbar
        count={
          <Suspense
            fallback={
              <AdministrationCountLoading
                label={m.administrationOrderCountLoading({}, { locale })}
              />
            }
          >
            <OrderCount locale={locale} result={result} />
          </Suspense>
        }
        filterLayout="inline"
        filters={
          <Suspense fallback={<AdministrationFiltersLoading fields={2} />}>
            <OrderFiltersContent range={range} />
          </Suspense>
        }
        label={m.administrationOrderTableControls({}, { locale })}
      />
      <Suspense
        fallback={
          <AdministrationCollectionLoading
            label={m.administrationOrderListLoading({}, { locale })}
            columns={6}
          />
        }
      >
        <OrderResultsContent locale={locale} result={result} />
      </Suspense>
    </>
  );
}

type OrdersPage = ReturnType<typeof loadAdministrationOrdersPage>;
type OrdersData = {
  readonly range: Awaited<OrdersPage["range"]>;
  readonly result: Awaited<OrdersPage["result"]>;
};

async function OrderCount({
  locale,
  result,
}: {
  readonly locale: Locale;
  readonly result: Promise<OrdersData["result"]>;
}) {
  const count = (await result).items.length;
  return (
    <AdministrationTableCount
      count={count}
      label={m.administrationOrderCount({ count }, { locale })}
    />
  );
}

async function OrderFiltersContent({
  range,
}: {
  readonly range: Promise<OrdersData["range"]>;
}) {
  return <OrdersAdministrationFilterForm query={await range} />;
}

async function OrderResultsContent({
  locale,
  result,
}: {
  readonly locale: Locale;
  readonly result: Promise<OrdersData["result"]>;
}) {
  return <OrderResults locale={locale} result={await result} />;
}

function OrderResults({
  locale,
  result,
}: {
  readonly locale: Locale;
  readonly result: OrdersData["result"];
}) {
  return (
    <>
      {!result.providerAvailable && (
        <AdministrationAlert className="mb-5" status="warning">
          {m.administrationOrderListProviderUnavailable({}, { locale })}
        </AdministrationAlert>
      )}
      {result.truncated && (
        <p className="mb-4 text-sm text-navy-blue/65">
          {m.administrationOrderListTruncated({}, { locale })}
        </p>
      )}
      <OrderTable orders={result.items} />
    </>
  );
}
