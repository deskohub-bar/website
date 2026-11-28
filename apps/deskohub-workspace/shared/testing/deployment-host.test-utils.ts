import { mock } from "bun:test";
import type { PublicOriginSettings } from "@/shared/deployment/public-origin";

/** A container deployment served on its configured public origin. */
export const containerDeploymentHost = {
  WORKSPACE_RUNTIME_HOST: "container",
  WORKSPACE_PUBLIC_ORIGIN: "https://workspace-public.example",
} as const satisfies PublicOriginSettings;

/**
 * Lets a test run as a deployment on another host, such as a container, by
 * overriding the host settings `env` reads. Call it before importing the
 * modules under test; the returned function sets the host, and `{}` restores
 * the test environment's own.
 */
export const mockDeploymentHost = async () => {
  let host: PublicOriginSettings = {};
  const envModule = await import("@/env");
  mock.module("@/env", () => ({
    ...envModule,
    env: new Proxy(envModule.env, {
      get: (target, key) =>
        Object.hasOwn(host, key)
          ? Reflect.get(host, key)
          : Reflect.get(target, key),
    }),
  }));
  return (next: PublicOriginSettings) => {
    host = next;
  };
};
