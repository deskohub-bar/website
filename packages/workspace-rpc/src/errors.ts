import { Schema } from "effect";

export class BackendUnavailable extends Schema.TaggedError<BackendUnavailable>()(
  "BackendUnavailable",
  {
    reason: Schema.Literals([
      "authorization",
      "caller",
      "content-type",
      "http-status",
      "protocol",
      "transport",
    ]),
    status: Schema.optionalKey(Schema.Int),
  }
) {}
