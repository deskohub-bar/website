import { Schema } from "effect";

const decodeErrorCode = Schema.decodeUnknownSync(
  Schema.Struct({ code: Schema.optionalKey(Schema.String) })
);

export const errorCode = async (response: Response) =>
  decodeErrorCode(await response.json()).code;
