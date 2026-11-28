import { NextEffect } from "@deskohub/next-effect";

/**
 * A Layer built once per process, by the first Workspace run that provides
 * it, and shared by every later run, such as a provider client and its token
 * cache. Share only capabilities that read nothing from a request and need no
 * finalizer. Only a successful build is kept, so a run after a failed build
 * builds again. Each shared layer keeps the layers it is built from to itself.
 */
export const shareAcrossRequests = NextEffect.shareAcrossRequests;

/**
 * `shareAcrossRequests` for a capability with finalizers, such as a
 * connection pool, with the `close` that releases it. A container registers
 * `close` as a runtime shutdown hook (`onRuntimeShutdown`); on Vercel it
 * never runs.
 */
export const shareUntilShutdown = NextEffect.shareUntilShutdown;
