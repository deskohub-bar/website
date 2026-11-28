import type { Metadata } from "next";
import { type ReactNode, Suspense } from "react";
import { createLocalePreferenceSaving } from "@/features/account/server/locale-preference-saving.server";
import {
  AdminShell,
  PassesNavigationItem,
} from "@/features/administration/admin-shell";
import { AdministrationLocaleSwitcher } from "@/features/administration/administration-locale-switcher";
import { m } from "@/features/administration/i18n";
import { getRequestLocale } from "@/features/i18n/server/request-locale";
import { isAdminPassViewsOpen } from "@/features/passes/admin/pass-admin-access.server";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  return {
    title: m.shellMetadataTitle({}, { locale }),
    robots: {
      index: false,
      follow: false,
    },
  };
}

export const instant = true;

export default function AdminLayout({
  breadcrumb,
  children,
  modal,
}: {
  readonly breadcrumb: ReactNode;
  readonly children: ReactNode;
  readonly modal: ReactNode;
}) {
  return (
    <>
      <AdminShell
        breadcrumb={breadcrumb}
        passesNavigation={{
          desktop: (
            <Suspense fallback={null}>
              <GatedPassesNavigation />
            </Suspense>
          ),
          mobile: (
            <Suspense fallback={null}>
              <GatedPassesNavigation mobile />
            </Suspense>
          ),
        }}
        localeSwitcher={
          <AdministrationLocaleSwitcher
            localePreference={createLocalePreferenceSaving()}
          />
        }
      >
        {children}
      </AdminShell>
      {modal}
    </>
  );
}

async function GatedPassesNavigation({
  mobile,
}: {
  readonly mobile?: boolean;
}) {
  return (await isAdminPassViewsOpen()) ? (
    <PassesNavigationItem mobile={mobile} />
  ) : null;
}
