import { Schema } from "effect";
import {
  entryPackProductSchema,
  unlimitedPassProductSchema,
} from "../passes/pass-offer";
import { workspaceCoworkProductTargetSchema } from "../reservation/cowork-reservation-product";
import { workspaceMeetingRoomProductTargetSchema } from "../reservation/meeting-room-reservation";
import { workspaceOfficeProductTargetSchema } from "../reservation/office-reservation";
import { workspaceTableProductTargetSchema } from "../reservation/table-reservation-product";

export const workspaceProductTargetSchema = Schema.Union([
  workspaceCoworkProductTargetSchema,
  workspaceMeetingRoomProductTargetSchema,
  workspaceOfficeProductTargetSchema,
  workspaceTableProductTargetSchema,
  entryPackProductSchema,
  Schema.Struct({
    kind: Schema.Literal("entry-pack"),
    tier: Schema.optionalKey(Schema.Never),
    size: Schema.optionalKey(Schema.Never),
  }),
  unlimitedPassProductSchema,
  Schema.Struct({
    kind: Schema.Literal("unlimited"),
    tier: Schema.optionalKey(Schema.Never),
  }),
]);

export type WorkspaceProductTarget = typeof workspaceProductTargetSchema.Type;
