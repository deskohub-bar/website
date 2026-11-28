import { AdministrationBreadcrumb } from "@/features/administration/breadcrumb.server";
import { isAdminPassViewsOpen } from "@/features/passes/admin/pass-admin-access.server";

export default async function AdminPassesBreadcrumb() {
  return (await isAdminPassViewsOpen()) ? (
    <AdministrationBreadcrumb segments={["passes"]} />
  ) : null;
}
