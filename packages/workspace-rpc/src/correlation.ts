import { Schema } from "effect";

export const correlationIdHeader = "x-deskohub-correlation-id";

export const CorrelationId = Schema.String.check(Schema.isUUID());
