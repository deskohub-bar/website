/**
 * The raw stage setting of a host: `WORKSPACE_DEPLOYMENT_STAGE` where the
 * host sets it, such as a Cloud Run revision, else Vercel's `VERCEL_ENV`.
 * Validation of the value stays with the environment schema. Plain
 * JavaScript, so `next.config.mjs` reads the build's stage the same way.
 *
 * @param {{
 *   readonly WORKSPACE_DEPLOYMENT_STAGE?: string | undefined;
 *   readonly VERCEL_ENV?: string | undefined;
 * }} environment
 * @returns {string | undefined}
 */
export const selectDeploymentStageSetting = (environment) =>
  environment.WORKSPACE_DEPLOYMENT_STAGE || environment.VERCEL_ENV;
