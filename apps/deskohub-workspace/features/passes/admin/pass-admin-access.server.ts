import "server-only";

import { cache } from "react";
import { authorizeAdministratorPage } from "@/features/administrators/server/administrator-authorization.server";
import { isCoworkPassesPageOpenAfterConnection } from "../backend/cowork-passes-release-gate.server";

export const isAdminPassViewsOpen = cache(async () => {
  await authorizeAdministratorPage();
  return isCoworkPassesPageOpenAfterConnection();
});
