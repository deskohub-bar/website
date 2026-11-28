import { Schema } from "effect";
import {
  entryPackProductSchema,
  unlimitedPassProductSchema,
} from "../passes/pass-offer";
import { workspaceCoworkProductIdentitySchema } from "../reservation/cowork-reservation-product";
import { workspaceMeetingRoomProductIdentitySchema } from "../reservation/meeting-room-reservation";
import { workspaceOfficeProductIdentitySchema } from "../reservation/office-reservation";
import { workspaceTableProductIdentitySchema } from "../reservation/table-reservation-product";

export const workspaceProductIdentitySchema = Schema.Union([
  workspaceCoworkProductIdentitySchema,
  workspaceMeetingRoomProductIdentitySchema,
  workspaceOfficeProductIdentitySchema,
  workspaceTableProductIdentitySchema,
  entryPackProductSchema,
  unlimitedPassProductSchema,
]);
