import { AdministrationBreadcrumb } from "@/features/administration/breadcrumb.server";

export default function ReusableEmailsBreadcrumb() {
  return <AdministrationBreadcrumb segments={["email-campaigns", "library"]} />;
}
