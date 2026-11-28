import { Effect } from "effect";
import { AutomationUnitProcessor } from "@/features/email-campaigns/automation/backend/automation-unit-processor.service";
import { automationUnitTopic } from "@/features/email-campaigns/automation/backend/automation-unit-queue.service";
import { processAutomationUnitMessage } from "@/features/email-campaigns/automation/backend/automation-unit-queue-consumer";
import { defineQueueRoute } from "@/shared/backend/queue/queue-route";

export const maxDuration = 300;

export const POST = defineQueueRoute(
  "emailAutomationUnitQueue",
  automationUnitTopic.topic,
  automationUnitTopic.consume((message) =>
    processAutomationUnitMessage(message).pipe(
      Effect.provide(AutomationUnitProcessor.Live)
    )
  )
);
