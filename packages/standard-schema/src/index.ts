import type { StandardSchemaV1 } from "@standard-schema/spec";

const isAsyncResult = <Output>(
  result:
    | StandardSchemaV1.Result<Output>
    | Promise<StandardSchemaV1.Result<Output>>
): result is Promise<StandardSchemaV1.Result<Output>> =>
  "then" in result && typeof result.then === "function";

const getSchemaValidationResult = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: unknown
): StandardSchemaV1.Result<Output> => {
  const result = schema["~standard"].validate(value);

  if (isAsyncResult(result)) {
    throw new Error("Async Standard Schema validation is not supported here");
  }

  return result;
};

export const decodeStandardSchema = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: unknown
): Output | undefined => {
  const result = getSchemaValidationResult(schema, value);
  return result.issues ? undefined : result.value;
};

export const parseStandardSchema = <Input, Output>(
  schema: StandardSchemaV1<Input, Output>,
  value: unknown,
  invalidMessage: string
): Output => {
  const result = getSchemaValidationResult(schema, value);

  if (result.issues) {
    throw new Error(invalidMessage, { cause: result.issues });
  }

  return result.value;
};
