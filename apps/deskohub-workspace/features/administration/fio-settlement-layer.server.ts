import "server-only";

import { Layer } from "effect";
import { WorkspaceDatabase } from "@/db/database.service";
import { FioPaymentSettlementRepository } from "@/features/checkout/backend/repositories/fio-payment-settlement.repository";

export const administrationFioSettlements =
  FioPaymentSettlementRepository.Default.pipe(
    Layer.provide(WorkspaceDatabase.Default)
  );
