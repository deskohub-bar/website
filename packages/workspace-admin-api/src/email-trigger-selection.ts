import { Array as Arr, Predicate, Schema } from "effect";
import type { EmailDocument } from "./emails";

export const emailTriggerEvents = [
  "entry-pack-expiring",
  "unlimited-ending",
] as const;

export const EmailTriggerEvent = Schema.Literals(emailTriggerEvents);
export type EmailTriggerEvent = typeof EmailTriggerEvent.Type;

export const EmailTriggerSelection = Schema.Struct({
  kind: Schema.Literal("trigger"),
  trigger: EmailTriggerEvent,
});
export type EmailTriggerSelection = typeof EmailTriggerSelection.Type;

export type EmailTriggerField = {
  readonly name: string;
  readonly kind: "string" | "number" | "url";
  readonly optional?: boolean;
};

const entryPackExpiringFields: readonly EmailTriggerField[] = [
  { name: "firstName", kind: "string", optional: true },
  { name: "tier", kind: "string" },
  { name: "endsOn", kind: "string" },
  { name: "remainingEntries", kind: "number" },
  { name: "totalEntries", kind: "number" },
  { name: "actionUrl", kind: "url" },
];

const unlimitedEndingFields: readonly EmailTriggerField[] = [
  { name: "firstName", kind: "string", optional: true },
  { name: "tier", kind: "string" },
  { name: "endsOn", kind: "string" },
  { name: "renewalStartsOn", kind: "string" },
  { name: "deskLabel", kind: "string", optional: true },
  { name: "actionUrl", kind: "url" },
];

export const emailTriggerFieldCatalogue: Readonly<
  Record<EmailTriggerEvent, readonly EmailTriggerField[]>
> = {
  "entry-pack-expiring": entryPackExpiringFields,
  "unlimited-ending": unlimitedEndingFields,
};

export const isEmailTriggerEvent = Schema.is(EmailTriggerEvent);

export const emailTriggerFields = (
  trigger: EmailTriggerEvent
): readonly EmailTriggerField[] => emailTriggerFieldCatalogue[trigger];

export const emailTriggerFieldAt = (
  trigger: EmailTriggerEvent,
  field: readonly string[] | undefined
): EmailTriggerField | undefined =>
  field?.length === 1
    ? emailTriggerFieldCatalogue[trigger].find(
        (candidate) => candidate.name === field[0]
      )
    : undefined;

export const isEmailTriggerInlineField = (
  field: EmailTriggerField | undefined
): boolean =>
  field !== undefined && (field.kind === "string" || field.kind === "number");

export const isEmailTriggerUrlField = (
  field: EmailTriggerField | undefined
): boolean => field !== undefined && field.kind === "url";

const isHttpsUrl = (value: Schema.Json): boolean =>
  Predicate.isString(value) && URL.parse(value)?.protocol === "https:";

const matchesFieldValue = (
  field: EmailTriggerField,
  value: Schema.Json | undefined
): boolean => {
  if (value === undefined || value === null) return Boolean(field.optional);
  switch (field.kind) {
    case "string":
      return Predicate.isString(value);
    case "number":
      return Predicate.isNumber(value) && Number.isFinite(value);
    case "url":
      return isHttpsUrl(value);
  }
};

/** Validates a resolved trigger record against its trigger catalogue. */
export const matchesEmailTriggerValue = (
  trigger: EmailTriggerEvent,
  value: Schema.Json
): boolean => {
  if (
    value === null ||
    !Predicate.isObjectKeyword(value) ||
    Arr.isArray<Schema.Json>(value)
  )
    return false;
  const fields = emailTriggerFieldCatalogue[trigger];
  const allowed = new Set(fields.map(({ name }) => name));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return fields.every((field) =>
    matchesFieldValue(
      field,
      Object.hasOwn(value, field.name) ? value[field.name] : undefined
    )
  );
};

/** Distinct trigger events required by the document's referenced values. */
export const documentEmailTriggerEvents = (
  document: Pick<EmailDocument, "values" | "structure" | "translations">,
  referencedNames?: ReadonlySet<string>
): readonly EmailTriggerEvent[] => {
  const triggers = new Set<EmailTriggerEvent>();
  for (const definition of document.values) {
    if (referencedNames && !referencedNames.has(definition.name)) continue;
    if (definition.source.kind === "trigger") {
      triggers.add(definition.source.trigger);
    }
  }
  return [...triggers];
};
