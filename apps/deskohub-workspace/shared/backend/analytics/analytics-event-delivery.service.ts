import "server-only";

import type {
  PostHogDistinctId,
  PostHogEventId,
} from "@deskohub/analytics-posthog/identifiers";
import { Context, Effect, Layer, Predicate, Schema } from "effect";
import { PostHog } from "posthog-node";
import { postHogRuntimeConfig } from "@/shared/backend/config/posthog.config";
import { runStandaloneWorkspaceEffect } from "@/shared/backend/standalone-workspace-effect";
import { keepRuntimeAliveUntil } from "@/shared/deployment/runtime-lifecycle";
import { temporalInstantToDate } from "@/shared/utils/temporal";

/** A server event as PostHog receives it, before the SDK's own fields. */
export interface AnalyticsEventMessage {
  readonly distinctId: PostHogDistinctId;
  readonly event: string;
  readonly properties: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly timestamp: Temporal.Instant;
  readonly uuid: PostHogEventId;
}

export interface IAnalyticsEventDelivery {
  /** Hands the event over for delivery. Never fails or waits for PostHog. */
  readonly send: (message: AnalyticsEventMessage) => Effect.Effect<void>;
}

/** Where server events go: PostHog in production, memory in tests. */
export class AnalyticsEventDelivery extends Context.Service<
  AnalyticsEventDelivery,
  IAnalyticsEventDelivery
>()("@deskohub-workspace/analytics/AnalyticsEventDelivery") {
  /**
   * Queues events on the process's PostHog capture client, or drops them
   * when PostHog isn't configured.
   */
  static Default = Layer.sync(this, () => {
    const client = processCaptureClient();
    return client ? makePostHogEventDelivery(client) : discardingDelivery;
  });
}

/** The part of a `posthog-node` client that delivers events. */
type PostHogCaptureClient = Pick<PostHog, "capture">;

const isEventUuid = Schema.is(Schema.String.check(Schema.isGUID()));

export const makePostHogEventDelivery = (
  client: PostHogCaptureClient
): IAnalyticsEventDelivery => ({
  send: (message) =>
    Effect.try(() => {
      const { $process_person_profile: processPersonProfile, ...properties } =
        message.properties;
      client.capture({
        distinctId: message.distinctId,
        event: message.event,
        options: Predicate.isBoolean(processPersonProfile)
          ? { process_person_profile: processPersonProfile }
          : undefined,
        properties,
        timestamp: temporalInstantToDate(message.timestamp),
        // Occurrence keys correlate local logs. Let the SDK generate the
        // wire UUID when the key has no UUID format.
        uuid: isEventUuid(message.uuid) ? message.uuid : undefined,
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Server analytics event not queued", {
          event: message.event,
          uuid: message.uuid,
          cause,
        })
      )
    ),
});

/** Without a PostHog project, server events go nowhere. */
const discardingDelivery: IAnalyticsEventDelivery = {
  send: () => Effect.void,
};

/** Whether this deployment sends server events at all. */
export const isServerAnalyticsEnabled = Boolean(
  postHogRuntimeConfig.projectToken
);

const serverAnalyticsFlushTimeout = "2 seconds";

/**
 * Sends the events the process's capture client still holds, within the
 * post-response deadline. Runs with the telemetry flush every Workspace run
 * gets: after the response, or before a task or work that already runs after
 * the response settles. Never fails: the client logs a failed delivery, and
 * an overdue flush is logged here.
 */
export const flushServerAnalytics: Effect.Effect<void> = Effect.suspend(() => {
  const client = existingCaptureClient();
  if (!client) return Effect.void;
  return Effect.tryPromise(() => client.flush()).pipe(
    Effect.timeoutOrElse({
      duration: serverAnalyticsFlushTimeout,
      orElse: () =>
        Effect.logWarning(
          "Server analytics flush exceeded its post-response deadline"
        ),
    }),
    // The client's error listener reports delivery failures.
    Effect.ignore
  );
});

/**
 * One capture client per process, shared by every module instance Next.js
 * loads, so a flush reaches the events any of them queued. It never evaluates
 * feature flags, which have their own client. Each queued event extends the
 * serverless invocation (`keepRuntimeAliveUntil`) until a debounced flush sends
 * it, which covers an event the telemetry flush misses.
 */
const captureClientKey = Symbol.for(
  "@deskohub-workspace/analytics/capture-client"
);

// Only this module writes the slot, so the annotation checks those writes;
// it trusts, rather than verifies, a value another module instance stored.
type CaptureClientHolder = typeof globalThis & {
  [captureClientKey]?: PostHog;
};

const existingCaptureClient = () => {
  const holder: CaptureClientHolder = globalThis;
  return holder[captureClientKey];
};

const processCaptureClient = () => {
  const { ingestHost, projectToken } = postHogRuntimeConfig;
  if (!projectToken) return undefined;
  const holder: CaptureClientHolder = globalThis;
  holder[captureClientKey] ??= createCaptureClient(projectToken, ingestHost);
  return holder[captureClientKey];
};

const createCaptureClient = (projectToken: string, host: string) => {
  const client = new PostHog(projectToken, {
    host,
    waitUntil: keepRuntimeAliveUntil,
  });
  client.on("error", (cause) => {
    void Effect.logWarning("Server analytics delivery failed", { cause }).pipe(
      runStandaloneWorkspaceEffect("analytics.delivery")
    );
  });
  return client;
};
