import { fileURLToPath } from "node:url";

export const workspaceMigrationsFolder = fileURLToPath(
  new URL("./migrations", import.meta.url)
);
