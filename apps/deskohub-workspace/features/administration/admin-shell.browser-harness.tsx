import { createRoot } from "react-dom/client";
import { isLocale } from "@/features/i18n";
import { RouteLocaleProvider } from "@/features/i18n/route-locale";
import { AdminShell } from "./admin-shell";
import { AdministrationLocaleSwitcher } from "./administration-locale-switcher";

const mountPoint = document.getElementById("admin-shell-test-root");

if (!mountPoint) {
  throw new Error("The AdminShell browser harness root is missing.");
}

const locale = mountPoint.dataset.locale;
if (!isLocale(locale)) {
  throw new Error(
    `The AdminShell browser harness locale is invalid: ${String(locale)}`
  );
}

createRoot(mountPoint).render(
  <RouteLocaleProvider locale={locale}>
    <AdminShell
      breadcrumb={null}
      localeSwitcher={<AdministrationLocaleSwitcher />}
    >
      <main id="main-content">Synthetic administration page</main>
    </AdminShell>
  </RouteLocaleProvider>
);
