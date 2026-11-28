import { Suspense } from "react";
import { AdministrationRouteLoading } from "@/features/administration/loading";
import { AdminPassDetailScreen } from "@/features/passes/admin/pass-detail-screen";

export default function AdminPassPage({
  params,
}: {
  readonly params: Promise<{ readonly passId: string }>;
}) {
  return (
    <Suspense fallback={<AdministrationRouteLoading />}>
      <AdminPassDetailScreen params={params} />
    </Suspense>
  );
}
