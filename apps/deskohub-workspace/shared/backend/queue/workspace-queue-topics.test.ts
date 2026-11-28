import { expect, test } from "bun:test";
import vercelConfig from "@/vercel.json";
import {
  isWorkspaceQueueTopic,
  workspaceQueueTopics,
} from "./workspace-queue-topics";

test("names the route of each queue topic Vercel triggers, and only those", () => {
  const triggeredRoutes = Object.entries(vercelConfig.functions).flatMap(
    ([route, { experimentalTriggers }]) =>
      experimentalTriggers
        .filter(({ type }) => type === "queue/v2beta")
        .map(({ topic }) => [topic, route] as const)
  );

  expect(
    Object.fromEntries(
      Object.entries(workspaceQueueTopics).map(([topic, path]) => [
        topic,
        `app${path}/route.ts`,
      ])
    )
  ).toEqual(Object.fromEntries(triggeredRoutes));
});

test("recognizes only Workspace queue topics", () => {
  expect(isWorkspaceQueueTopic("workspace-paid-fulfillment")).toBe(true);
  expect(isWorkspaceQueueTopic("workspace-unknown")).toBe(false);
  expect(isWorkspaceQueueTopic("toString")).toBe(false);
});
