import type { workspaceProductIdentitySchema } from "@deskohub/workspace-domain/features/checkout/product-identity";
import {
  getWorkspaceTableProductKey,
  workspaceTableProductKeySchema,
} from "@deskohub/workspace-domain/features/reservation/table-reservation-product";

export { workspaceProductIdentitySchema } from "@deskohub/workspace-domain/features/checkout/product-identity";

import { Match, Schema } from "effect";
import {
  entryPackProductKeySchema,
  getPassProductKey,
  unlimitedPassProductKeySchema,
} from "@/features/passes/pass-offer";
import {
  getWorkspaceCoworkProductKey,
  workspaceCoworkProductKeySchema,
} from "@/features/reservation/cowork-reservation-product";
import {
  getWorkspaceMeetingRoomProductKey,
  workspaceMeetingRoomProductKeySchema,
} from "@/features/reservation/meeting-room-reservation";
import {
  getWorkspaceOfficeProductKey,
  workspaceOfficeProductKeySchema,
} from "@/features/reservation/office-reservation";

export type WorkspaceProductIdentity =
  typeof workspaceProductIdentitySchema.Type;

export const workspaceProductKeySchema = Schema.Union([
  workspaceCoworkProductKeySchema,
  workspaceMeetingRoomProductKeySchema,
  workspaceOfficeProductKeySchema,
  workspaceTableProductKeySchema,
  entryPackProductKeySchema,
  unlimitedPassProductKeySchema,
]);

export type WorkspaceProductKey = typeof workspaceProductKeySchema.Type;

export const getWorkspaceProductKey = (
  product: WorkspaceProductIdentity
): WorkspaceProductKey =>
  Match.value(product).pipe(
    Match.discriminatorsExhaustive("kind")({
      cowork: getWorkspaceCoworkProductKey,
      "meeting-room": getWorkspaceMeetingRoomProductKey,
      office: getWorkspaceOfficeProductKey,
      table: getWorkspaceTableProductKey,
      "entry-pack": getPassProductKey,
      unlimited: getPassProductKey,
    })
  );

export const getCanonicalWorkspaceProductIdentity = (
  product: WorkspaceProductIdentity
): WorkspaceProductIdentity =>
  Match.value(product).pipe(
    Match.discriminatorsExhaustive("kind")({
      cowork: ({ kind, tier }) => ({ kind, tier }),
      "meeting-room": ({ duration, kind }) => ({
        kind,
        duration,
      }),
      office: ({ dayCount, kind, seats }) => ({ kind, seats, dayCount }),
      table: ({ durationMinutes, kind, seats }) => ({
        kind,
        seats,
        durationMinutes,
      }),
      "entry-pack": ({ kind, size, tier }) => ({ kind, size, tier }),
      unlimited: ({ kind, tier }) => ({ kind, tier }),
    })
  );
