import { Schema } from "effect";

/** The role assigned to a Workspace Cloud Run container by its template. */
export const WorkspaceServiceRole = Schema.Literals([
  "api",
  "tasks-worker",
  "scheduler-worker",
]);
export type WorkspaceServiceRole = typeof WorkspaceServiceRole.Type;
