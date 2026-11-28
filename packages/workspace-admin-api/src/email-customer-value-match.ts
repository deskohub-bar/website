import { Array as Arr, Predicate, type Schema } from "effect";
import type { EmailCustomerField } from "./email-customer-selection";

type JsonValue = NonNullable<Schema.Json>;

/** Whether a JSON value is one the field descriptor allows. */
export function matchesEmailCustomerField(
  value: Schema.Json | undefined,
  field: EmailCustomerField
): boolean {
  if (value === undefined) return field.optional;
  if (value === null) return field.nullable;
  switch (field.kind) {
    case "scalar":
      return matchesScalar(value, field);
    case "union":
      return field.alternatives.some((alternative) =>
        matchesEmailCustomerField(value, alternative)
      );
    case "list":
      return (
        Arr.isArray<Schema.Json>(value) &&
        value.every((item) => matchesEmailCustomerField(item, field.element))
      );
    case "record":
      return matchesRecord(value, field);
    case "unsupported":
      return false;
  }
}

const matchesScalar = (
  value: JsonValue,
  field: Extract<EmailCustomerField, { readonly kind: "scalar" }>
) =>
  scalarTypeMatchers[field.type](value) &&
  (field.choices === undefined ||
    field.choices.some((choice) => choice === value));

const scalarTypeMatchers: Readonly<
  Record<
    Extract<EmailCustomerField, { readonly kind: "scalar" }>["type"],
    (value: JsonValue) => boolean
  >
> = {
  string: Predicate.isString,
  number: Predicate.isNumber,
  boolean: Predicate.isBoolean,
};

/** A record holds only declared fields, each matching its descriptor when present. */
const matchesRecord = (
  value: JsonValue,
  field: Extract<EmailCustomerField, { readonly kind: "record" }>
) =>
  Predicate.isObjectKeyword(value) &&
  !Arr.isArray<Schema.Json>(value) &&
  Object.keys(value).every((key) => Object.hasOwn(field.fields, key)) &&
  Object.entries(field.fields).every(([key, descriptor]) =>
    matchesEmailCustomerField(
      Object.hasOwn(value, key) ? value[key] : undefined,
      descriptor
    )
  );
