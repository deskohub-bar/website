import "server-only";

import {
  type DotyposCustomerId,
  DotyposService,
  type DotyposTableId,
} from "@deskohub/dotypos";
import { Effect, Layer, Option, Schema } from "effect";
import { notFound } from "next/navigation";
import { cache } from "react";
import { WorkspaceDatabase } from "@/db/database.service";
import { AdministrationCustomerDirectory } from "@/features/administration/customer-directory.service";
import {
  AdministrationRecordNotFound,
  runAdministrationPage,
} from "@/features/administrators/server/administration-request.server";
import { orderIdSchema } from "@/features/order";
import type { WorkspaceReservationId } from "@/features/reservation/persistence-contracts";
import { WorkspaceDotyposLayer } from "@/shared/backend/config/dotypos.config";
import { isAdminPassViewsOpen } from "./pass-admin-access.server";
import {
  listAdminPasses,
  readAdminCustomerPasses,
  readAdminPass,
  readReservationPassLinks,
} from "./pass-reads";

export const adminPassReadsLayer = Layer.mergeAll(
  WorkspaceDatabase.Default,
  AdministrationCustomerDirectory.Live
);

const requireAdminPassViews = async () => {
  if (!(await isAdminPassViewsOpen())) notFound();
};

export const loadAdminPasses = async () => {
  await requireAdminPassViews();
  return runAdministrationPage(
    "administration.passes",
    listAdminPasses({}),
    adminPassReadsLayer
  );
};

export const loadAdminPass = cache(async (id: string) => {
  await requireAdminPassViews();
  const passId = Option.getOrElse(
    Schema.decodeOption(orderIdSchema)(id),
    notFound
  );
  return runAdministrationPage(
    "administration.pass",
    Effect.gen(function* () {
      const detail = yield* readAdminPass(passId);
      if (!detail) return yield* new AdministrationRecordNotFound();

      const deskLabels = new Map<DotyposTableId, string>();
      if (detail.days.length > 0) {
        const dotypos = yield* DotyposService;
        const tables = yield* dotypos
          .getTables()
          .pipe(Effect.orElseSucceed(() => []));
        for (const table of tables) {
          const label = table.name?.trim();
          if (label) deskLabels.set(table.id, label);
        }
      }
      return { ...detail, deskLabels };
    }),
    Layer.merge(adminPassReadsLayer, WorkspaceDotyposLayer)
  );
});

export const loadAdminCustomerPasses = async (customerId: DotyposCustomerId) =>
  (await isAdminPassViewsOpen())
    ? runAdministrationPage(
        "administration.customer-passes",
        readAdminCustomerPasses(customerId),
        adminPassReadsLayer
      )
    : null;

export const loadReservationPassLinks = async (
  ids: readonly WorkspaceReservationId[]
) =>
  ids.length > 0 && (await isAdminPassViewsOpen())
    ? runAdministrationPage(
        "administration.reservation-pass-links",
        readReservationPassLinks(ids),
        WorkspaceDatabase.Default
      )
    : undefined;
