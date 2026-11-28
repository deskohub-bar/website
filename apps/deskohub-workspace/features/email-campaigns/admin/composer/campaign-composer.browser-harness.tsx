import { EmailId } from "@deskohub/workspace-admin-api";
import { Schema } from "effect";
import { createRoot } from "react-dom/client";
import { AdminShell } from "@/features/administration/admin-shell";
import { AdministrationPage } from "@/features/administration/components";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import { locales } from "@/features/i18n/routing";
import { CampaignComposer } from "./campaign-composer";
import { newCampaignComposerFields } from "./campaign-composer-fields";

const mountPoint = document.getElementById("campaign-composer-test-root");

if (!mountPoint) {
  throw new Error("The campaign composer browser harness root is missing.");
}

const locale = Schema.decodeUnknownSync(Schema.Literals(locales))(
  mountPoint.dataset.locale
);

createRoot(mountPoint).render(
  <RouteLocaleProvider locale={locale}>
    <AdminShell breadcrumb={null} localeSwitcher={null}>
      <AdministrationPage>
        <CampaignComposer
          adminInbox={null}
          audiences={[]}
          campaign={undefined}
          initialFields={newCampaignComposerFields}
          publishedEmails={
            mountPoint.dataset.published
              ? [
                  {
                    emailId: EmailId.make("synthetic-published-offer"),
                    title: "Published cowork offer",
                    locales: ["en-US"],
                  },
                ]
              : []
          }
          templates={[]}
        />
      </AdministrationPage>
    </AdminShell>
  </RouteLocaleProvider>
);
