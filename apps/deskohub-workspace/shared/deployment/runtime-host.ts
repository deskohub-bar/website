import { Schema } from "effect";

/**
 * What runs the Workspace server: Vercel functions, or a long-lived
 * container such as a Cloud Run revision, which must drain and flush on
 * SIGTERM itself (`installRuntimeShutdown`). Unset means Vercel.
 */
export const runtimeHostSchema = Schema.Literals(["vercel", "container"]);

/** The service role a container process plays, as logs label it. */
export const serviceRoleSchema = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/)
);

export const defaultServiceRole = "web";

export type RuntimeHost = typeof runtimeHostSchema.Type;
