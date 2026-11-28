import { Schema } from "effect";
import {
  workspaceCoworkCurrentTiers,
  workspaceCoworkTiers,
} from "../checkout/product-catalog";
import { coworkReservationKind } from "./reservation-kind";

export const workspaceCoworkProductIdentitySchema = Schema.Struct({
  kind: Schema.Literal(coworkReservationKind),
  tier: Schema.Literals(workspaceCoworkTiers),
});

/**
 * A discount target for cowork. Without a tier it covers every cowork tier;
 * with one it covers only that saleable tier.
 */
export const workspaceCoworkProductTargetSchema = Schema.Struct({
  kind: workspaceCoworkProductIdentitySchema.fields.kind,
  tier: Schema.optional(Schema.Literals(workspaceCoworkCurrentTiers)),
});
