import { AdministrationBreadcrumb } from "@/features/administration/breadcrumb.server";

export default async function ReusableEmailBreadcrumb({
  params,
}: PageProps<"/[locale]/admin/email-campaigns/library/[emailId]">) {
  const { emailId } = await params;
  return (
    <AdministrationBreadcrumb
      segments={["email-campaigns", "library", emailId]}
    />
  );
}
