import type { ReactNode } from "react";
import { m } from "@/features/administration/i18n";
import { AdministrationPage } from "@/features/administration/page-frame";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { AdminPassFilters } from "./pass-list";
import { loadAdminPasses } from "./pass-page-data.server";

export async function AdminPassListScreen({
  actions,
}: {
  readonly actions?: ReactNode;
}) {
  const [locale, initialPage] = await Promise.all([
    getRequestLocale(),
    loadAdminPasses(),
  ]);
  return (
    <AdministrationPage>
      <h1 className="sr-only">{m.passesTitle({}, { locale })}</h1>
      <AdminPassFilters
        actions={actions}
        initialPage={initialPage}
        locale={locale}
      />
    </AdministrationPage>
  );
}
