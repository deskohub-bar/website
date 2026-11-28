import * as GCP from "@alchemy.run/gcp";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import { AuthProvidersLive } from "alchemy/Auth/Registry";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

/**
 * GCP credentials and the effective project, resolved exactly as the
 * Alchemy GCS state store resolves them, so the state, the release record
 * and Cloud Run readback all act as one identity. Environment credentials
 * come first: a set `GOOGLE_ACCESS_TOKEN` requires `GOOGLE_PROJECT_ID` (or
 * `GOOGLE_CLOUD_PROJECT`) and fails without one; only without a token is
 * `GOOGLE_APPLICATION_CREDENTIALS` read, as a service-account JSON key. In CI nothing else is consulted;
 * elsewhere the selected Alchemy profile (`ALCHEMY_PROFILE`, default
 * `default`) supplies a gcloud configuration, a service-account key or a
 * stored token. Application Default Credentials are not searched: no
 * well-known ADC file, no `authorized_user` or `external_account`
 * (workload identity federation) key file, and no metadata server.
 */
export const workspaceGcpAccess = GCP.fromCredentials().pipe(
  Layer.provideMerge(GCP.fromAuthProvider()),
  Layer.provideMerge(GCP.GcpAuth),
  Layer.provideMerge(CredentialsStoreLive)
);

/** Access for Google REST clients: credentials plus an HTTP transport. */
export const workspaceGoogleApiAccess = Layer.mergeAll(
  workspaceGcpAccess,
  FetchHttpClient.layer
);

/**
 * What the Alchemy CLI supplies to its auth providers (the provider
 * registry, profiles and platform services), for entries that run outside
 * `alchemy` itself, such as the release command.
 */
export const standaloneAlchemyAuth = Layer.mergeAll(
  AuthProvidersLive,
  ProfileStoreLive
).pipe(Layer.provideMerge(PlatformServices));
