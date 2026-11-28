"use client";

import { Option, Schema } from "effect";
import { Search } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { AdministrationLink } from "@/features/administration/admin-link";
import {
  administrationHref,
  localizeAdministrationHref,
} from "@/features/administration/administration-href";
import {
  AdministrationFilterField,
  AdministrationFilterInput,
  AdministrationFilterSelect,
} from "@/features/administration/filter-controls";
import { m } from "@/features/administration/i18n";
import { AdministrationResponsiveTable } from "@/features/administration/table-frame";
import {
  AdministrationTableCount,
  AdministrationTableToolbar,
} from "@/features/administration/table-toolbar";
import type { Locale } from "@/features/i18n";
import { Button } from "@/shared/components/ui/button";
import { StatusBadge } from "@/shared/components/ui/status-badge";
import { formatCount } from "@/shared/utils/number";
import { passTiers } from "../pass-offer";
import { formatPassDate, getPassTierName } from "../pass-offer.i18n";
import {
  type AdminPassListInput,
  type AdminPassPage,
  type AdminPassSummary,
  adminPassListInput,
  adminPassPage,
  adminPassProducts,
  adminPassSearchLimit,
  adminPassSources,
  adminPassStatuses,
} from "./pass-list-contract";
import {
  PassPartyName,
  PassStatusBadge,
  passHref,
  passLastDate,
  passPaidLabel,
  passPartyLabel,
  passProductLabel,
  passProductTitle,
  passRemainingLabel,
  passStatusLabel,
} from "./pass-presentation";

export function AdminPassFilters({
  initialPage,
  locale,
  actions,
}: {
  readonly initialPage: AdminPassPage;
  readonly locale: Locale;
  readonly actions?: ReactNode;
}) {
  const [product, setProduct] = useState("");
  const [tier, setTier] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [selection, setSelection] = useState<{
    readonly input: AdminPassListInput;
    readonly data: AdminPassPage;
    readonly initialPage: AdminPassPage;
  }>();
  const current =
    selection?.initialPage === initialPage ? selection : undefined;
  const applied = current?.input ?? {};
  const results = current?.data ?? initialPage;
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const page = applied.page ?? 1;
  const endpoint = localizeAdministrationHref(
    administrationHref("/[locale]/admin/passes/search"),
    locale
  );
  const labels = {
    paid: m.passesPaid({}, { locale }),
    gift: m.passesGift({}, { locale }),
    complimentary: m.passesGranted({}, { locale }),
  };

  async function search(input: AdminPassListInput) {
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        cache: "no-store",
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      const next = Schema.decodeUnknownSync(adminPassPage)(
        await response.json()
      );
      setSelection({ input, data: next, initialPage });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = String(
      new FormData(event.currentTarget).get("query") ?? ""
    ).trim();
    const input = Schema.decodeUnknownOption(adminPassListInput)({
      ...(product && { product }),
      ...(tier && { tier }),
      ...(status && { status }),
      ...(source && { source }),
      ...(query && { query }),
    });
    if (Option.isSome(input)) void search(input.value);
    else setFailed(true);
  }

  return (
    <>
      <form action={endpoint} method="post" onSubmit={submit}>
        <fieldset disabled={pending}>
          <AdministrationTableToolbar
            actions={actions}
            label={m.passesControls({}, { locale })}
            count={
              <AdministrationTableCount
                count={results.total}
                label={m.passesCount(
                  {
                    count: formatCount(results.total, locale),
                  },
                  { locale }
                )}
              />
            }
            search={
              <div className="relative min-w-0">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-3 size-4 text-navy-blue/45"
                />
                <AdministrationFilterInput
                  aria-label={m.passesSearch({}, { locale })}
                  autoComplete="off"
                  className="pl-9"
                  maxLength={adminPassSearchLimit}
                  minLength={2}
                  name="query"
                  placeholder={m.passesSearchPlaceholder({}, { locale })}
                  type="search"
                />
              </div>
            }
            filters={
              <div className="grid items-end gap-3 grid-cols-2 md:grid-cols-4 2xl:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
                <AdministrationFilterField
                  htmlFor="pass-product"
                  label={m.passesProduct({}, { locale })}
                >
                  <AdministrationFilterSelect
                    id="pass-product"
                    value={product}
                    onChange={(event) => setProduct(event.currentTarget.value)}
                  >
                    <option value="">
                      {m.passesAllProducts({}, { locale })}
                    </option>
                    {adminPassProducts.map((value) => (
                      <option key={value} value={value}>
                        {passProductLabel(value, locale)}
                      </option>
                    ))}
                  </AdministrationFilterSelect>
                </AdministrationFilterField>
                <AdministrationFilterField
                  htmlFor="pass-tier"
                  label={m.passesTier({}, { locale })}
                >
                  <AdministrationFilterSelect
                    id="pass-tier"
                    value={tier}
                    onChange={(event) => setTier(event.currentTarget.value)}
                  >
                    <option value="">{m.passesAllTiers({}, { locale })}</option>
                    {passTiers.map((value) => (
                      <option key={value} value={value}>
                        {getPassTierName(value, locale)}
                      </option>
                    ))}
                  </AdministrationFilterSelect>
                </AdministrationFilterField>
                <AdministrationFilterField
                  htmlFor="pass-status"
                  label={m.passesStatus({}, { locale })}
                >
                  <AdministrationFilterSelect
                    id="pass-status"
                    value={status}
                    onChange={(event) => setStatus(event.currentTarget.value)}
                  >
                    <option value="">
                      {m.passesAllStatuses({}, { locale })}
                    </option>
                    {adminPassStatuses.map((value) => (
                      <option key={value} value={value}>
                        {passStatusLabel(value, locale)}
                      </option>
                    ))}
                  </AdministrationFilterSelect>
                </AdministrationFilterField>
                <AdministrationFilterField
                  htmlFor="pass-source"
                  label={m.passesSource({}, { locale })}
                >
                  <AdministrationFilterSelect
                    id="pass-source"
                    value={source}
                    onChange={(event) => setSource(event.currentTarget.value)}
                  >
                    <option value="">
                      {m.passesAllSources({}, { locale })}
                    </option>
                    {adminPassSources.map((value) => (
                      <option key={value} value={value}>
                        {labels[value]}
                      </option>
                    ))}
                  </AdministrationFilterSelect>
                </AdministrationFilterField>
                <Button
                  className="col-span-full 2xl:col-span-1"
                  type="submit"
                  variant="secondary"
                >
                  {m.passesSearchSubmit({}, { locale })}
                </Button>
              </div>
            }
          />
        </fieldset>
      </form>
      <p className="sr-only" role="status">
        {pending
          ? m.passesSearchPending({}, { locale })
          : m.passesCount(
              {
                count: formatCount(results.total, locale),
              },
              { locale }
            )}
      </p>
      <div role="alert">
        {failed && (
          <p className="mb-4 rounded-lg bg-burned-orange/10 p-3 text-sm text-burned-orange-ink">
            {m.passesSearchFailed({}, { locale })}
          </p>
        )}
      </div>
      {results.searchIncomplete && (
        <p className="mb-4 rounded-lg bg-sunset-yellow/15 p-3 text-sm text-navy-blue">
          {m.passesSearchIncomplete({}, { locale })}
        </p>
      )}
      <div aria-busy={pending}>
        <PassResults locale={locale} passes={results.passes} />
      </div>
      {(page > 1 || results.hasNextPage) && (
        <div className="mt-4 flex justify-end gap-2">
          <Button
            disabled={pending || page === 1}
            onClick={() => void search({ ...applied, page: page - 1 })}
            type="button"
            variant="secondary"
          >
            {m.passesPrevious({}, { locale })}
          </Button>
          <Button
            disabled={pending || !results.hasNextPage}
            onClick={() => void search({ ...applied, page: page + 1 })}
            type="button"
            variant="secondary"
          >
            {m.passesNext({}, { locale })}
          </Button>
        </div>
      )}
    </>
  );
}

function PassResults({
  passes,
  locale,
}: {
  readonly passes: readonly AdminPassSummary[];
  readonly locale: Locale;
}) {
  if (!passes.length)
    return (
      <p className="rounded-xl border border-navy-blue/10 bg-white p-6 text-sm">
        {m.passesEmpty({}, { locale })}
      </p>
    );
  const headings = [
    m.passesHolder({}, { locale }),
    m.passesProduct({}, { locale }),
    m.passesRemaining({}, { locale }),
    m.passesValid({}, { locale }),
    m.passesPaid({}, { locale }),
    m.passesStatus({}, { locale }),
  ];
  return (
    <AdministrationResponsiveTable
      desktop={
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{m.passesTitle({}, { locale })}</caption>
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
            {passes.map((pass) => (
              <tr className="border-t border-navy-blue/10" key={pass.id}>
                <td className="px-4 py-3">
                  <Holder pass={pass} locale={locale} />
                </td>
                <td className="px-4 py-3">
                  <Product pass={pass} locale={locale} />
                </td>
                <td className="px-4 py-3 font-medium">
                  {passRemainingLabel(pass, locale)}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <Validity pass={pass} locale={locale} />
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  {passPaidLabel(pass, locale)}
                </td>
                <td className="px-4 py-3">
                  <PassStatusBadge status={pass.status} locale={locale} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
      mobile={
        <ul className="divide-y divide-navy-blue/10">
          {passes.map((pass) => (
            <li className="space-y-3 p-4 text-sm" key={pass.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <Holder pass={pass} locale={locale} />
                <PassStatusBadge status={pass.status} locale={locale} />
              </div>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <Product pass={pass} locale={locale} />
                <p>{passPaidLabel(pass, locale)}</p>
              </div>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="font-medium">
                  {passRemainingLabel(pass, locale)}
                </p>
                <Validity pass={pass} locale={locale} />
              </div>
            </li>
          ))}
        </ul>
      }
    />
  );
}

function Holder({
  pass,
  locale,
}: {
  readonly pass: AdminPassSummary;
  readonly locale: Locale;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="font-medium">
        <PassPartyName party={pass.holder} locale={locale} />
      </div>
      {pass.claimed === false && (
        <StatusBadge tone="progress">
          {m.passesUnclaimed({}, { locale })}
        </StatusBadge>
      )}
      {pass.buyer && (
        <p className="text-xs text-navy-blue/65">
          {m.passesBoughtBy(
            { name: passPartyLabel(pass.buyer, locale) },
            { locale }
          )}
        </p>
      )}
    </div>
  );
}

function Product({
  pass,
  locale,
}: {
  readonly pass: AdminPassSummary;
  readonly locale: Locale;
}) {
  return (
    <div>
      <AdministrationLink
        className="font-medium underline decoration-navy-blue/25 underline-offset-2 hover:decoration-current"
        href={passHref(pass.id)}
      >
        {passProductTitle(pass, locale)}
      </AdministrationLink>
      <p className="text-xs text-navy-blue/65">
        {getPassTierName(pass.tier, locale)}
      </p>
    </div>
  );
}

function Validity({
  pass,
  locale,
}: {
  readonly pass: AdminPassSummary;
  readonly locale: Locale;
}) {
  const lastDay = passLastDate(pass, locale);
  if (!lastDay) return <p>{m.passesNoAccessDays({}, { locale })}</p>;
  return (
    <div>
      <p>{m.passesThroughDate({ date: lastDay }, { locale })}</p>
      <p className="text-xs text-navy-blue/65">
        {m.passesFromDate(
          { date: formatPassDate(pass.validFrom, locale) },
          { locale }
        )}
      </p>
    </div>
  );
}
