import { Suspense } from "react";
import { AdministrationRouteLoading } from "@/features/administration/loading";
import { EmailLibraryPage } from "@/features/emails/admin/library/email-library-page";

export default function ReusableEmailsRoute() {
  return (
    <Suspense fallback={<AdministrationRouteLoading />}>
      <EmailLibraryPage />
    </Suspense>
  );
}
