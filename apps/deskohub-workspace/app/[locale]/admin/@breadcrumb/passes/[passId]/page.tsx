import { Option, Schema } from "effect";
import { AdministrationBreadcrumbs } from "@/features/administration/admin-shell";
import { m } from "@/features/administration/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { orderIdSchema } from "@/features/order";
import { isAdminPassViewsOpen } from "@/features/passes/admin/pass-admin-access.server";

export default async function AdminPassBreadcrumb({
  params,
}: {
  readonly params: Promise<{ readonly passId: string }>;
}) {
  if (!(await isAdminPassViewsOpen())) return null;
  const [{ passId }, locale] = await Promise.all([params, getRequestLocale()]);
  if (Option.isNone(Schema.decodeOption(orderIdSchema)(passId))) return null;
  return (
    <AdministrationBreadcrumbs
      recordLabel={m.passesRecord({ id: passId }, { locale })}
      segments={["passes", passId]}
    />
  );
}
