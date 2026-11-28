import { Suspense } from "react";
import { AdministrationRouteLoading } from "@/features/administration/loading";
import { ReusableEmailPage } from "@/features/emails/admin/library/email-library-page";

export default function ReusableEmailRoute({
  params,
}: PageProps<"/[locale]/admin/email-campaigns/library/[emailId]">) {
  return (
    <Suspense fallback={<AdministrationRouteLoading />}>
      <ReusableEmailPage params={params} />
    </Suspense>
  );
}
