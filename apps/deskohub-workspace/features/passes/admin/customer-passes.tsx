import type { ReactNode } from "react";
import { AdministrationLink } from "@/features/administration/admin-link";
import { m } from "@/features/administration/i18n";
import type { Locale } from "@/features/i18n";
import { getPassTierName } from "../pass-offer.i18n";
import type { AdminPassSummary } from "./pass-list-contract";
import {
  PassStatusBadge,
  passHref,
  passPaidLabel,
  passPartyLabel,
  passProductTitle,
  passRemainingLabel,
  passValidityRange,
} from "./pass-presentation";

export function AdminCustomerPasses({
  name,
  held,
  boughtForOthers,
  locale,
  actions,
}: {
  readonly name: string;
  readonly held: readonly AdminPassSummary[];
  readonly boughtForOthers: readonly AdminPassSummary[];
  readonly locale: Locale;
  readonly actions?: ReactNode;
}) {
  return (
    <section aria-labelledby="customer-passes-heading">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl" id="customer-passes-heading">
          {m.passesTitle({}, { locale })}
        </h2>
        {actions}
      </div>
      <div className="space-y-4">
        <CustomerPassGroup
          heading={m.passesHeldBy({ name }, { locale })}
          locale={locale}
          passes={held}
          viewpoint="holder"
        />
        <CustomerPassGroup
          heading={m.passesGift({}, { locale })}
          locale={locale}
          passes={boughtForOthers}
          viewpoint="buyer"
        />
      </div>
    </section>
  );
}

function CustomerPassGroup({
  heading,
  locale,
  passes,
  viewpoint,
}: {
  readonly heading: string;
  readonly locale: Locale;
  readonly passes: readonly AdminPassSummary[];
  readonly viewpoint: "holder" | "buyer";
}) {
  return (
    <div>
      <h3 className="mb-2 font-semibold">{heading}</h3>
      <div className="rounded-xl border border-navy-blue/10 bg-white">
        {passes.length ? (
          <ul className="divide-y divide-navy-blue/10">
            {passes.map((pass) => {
              const other = viewpoint === "holder" ? pass.buyer : pass.holder;
              return (
                <li
                  className="grid gap-3 p-4 text-sm sm:grid-cols-[1fr_1fr_auto]"
                  key={pass.id}
                >
                  <div>
                    <AdministrationLink
                      className="font-semibold underline decoration-navy-blue/25 underline-offset-2 hover:decoration-current"
                      href={passHref(pass.id)}
                    >
                      {passProductTitle(pass, locale)}
                    </AdministrationLink>
                    <p className="text-navy-blue/70">
                      {getPassTierName(pass.tier, locale)}
                    </p>
                    {other && (
                      <p className="text-navy-blue/70">
                        {(viewpoint === "holder"
                          ? m.passesBoughtBy
                          : m.passesBoughtFor)(
                          { name: passPartyLabel(other, locale) },
                          { locale }
                        )}
                      </p>
                    )}
                    {pass.claimed === false && (
                      <p className="text-navy-blue/70">
                        {m.passesUnclaimed({}, { locale })}
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="font-medium">
                      {passRemainingLabel(pass, locale)}
                    </p>
                    <p className="text-xs text-navy-blue/65">
                      {passValidityRange(pass, locale)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:flex-col sm:items-end">
                    <PassStatusBadge locale={locale} status={pass.status} />
                    <p>{passPaidLabel(pass, locale)}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="p-4 text-sm text-navy-blue/65">
            {m.passesEmpty({}, { locale })}
          </p>
        )}
      </div>
    </div>
  );
}
