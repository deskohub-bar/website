import "server-only";

import type { DotyposReservationId } from "@deskohub/dotypos";
import type { ReservationStay } from "@deskohub/workspace-admin-api";
import { and, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import type { WorkspaceDatabaseClient } from "@/db/database.service";
import { equalsAny } from "@/db/equals-any";
import { workspaceReservations } from "@/db/schema";
import {
  type WorkspaceCoworkProductTier,
  workspaceCoworkTiers,
} from "@/features/checkout/product-catalog";
import { StoredReservationDetails } from "@/features/reservation/backend/stored-reservation-details.server";
import { getBookedCoworkStay } from "@/features/reservation/cowork-stay";

const isCoworkTier = Schema.is(Schema.Literals(workspaceCoworkTiers));

/**
 * The stored tier of each Workspace-booked cowork reservation among these
 * Dotypos reservations, by Dotypos ID, in one query. A reservation of another
 * family, without a Workspace row, or without a readable tier is absent.
 */
export const loadCoworkTiers = (
  db: WorkspaceDatabaseClient,
  dotyposReservationIds: readonly DotyposReservationId[]
) =>
  dotyposReservationIds.length === 0
    ? Effect.succeed(
        new Map<DotyposReservationId, WorkspaceCoworkProductTier>()
      )
    : db
        .select({
          dotyposReservationId: workspaceReservations.dotyposReservationId,
          tier: sql<string | null>`${StoredReservationDetails.property(
            "cowork",
            "tier"
          )}`,
        })
        .from(workspaceReservations)
        .where(
          and(
            equalsAny(
              workspaceReservations.dotyposReservationId,
              dotyposReservationIds
            ),
            sql`${StoredReservationDetails.kind} = 'cowork'`
          )
        )
        .pipe(
          Effect.map(
            (rows) =>
              new Map(
                rows.flatMap(({ dotyposReservationId, tier }) =>
                  dotyposReservationId !== null && isCoworkTier(tier)
                    ? [[dotyposReservationId, tier] as const]
                    : []
                )
              )
          )
        );

/**
 * Whether a booked visit is of the stay: a cowork visit of a known tier whose
 * provider interval and tier give that stay. A visit without a tier (another
 * family, or not booked through Workspace) is of no stay.
 */
export const isBookedStay = (
  stay: ReservationStay,
  visit: {
    readonly tier: WorkspaceCoworkProductTier | undefined;
    readonly interval: {
      readonly startsAt: Temporal.Instant;
      readonly endsAt: Temporal.Instant;
    };
  }
) =>
  visit.tier !== undefined &&
  getBookedCoworkStay({ tier: visit.tier, interval: visit.interval }) === stay;
