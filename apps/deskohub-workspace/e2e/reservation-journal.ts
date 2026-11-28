import { readFile } from "node:fs/promises";
import { Result, Schema } from "effect";
import { writeJsonAtomically } from "./runtime";

export const reservationIntentSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  caseId: Schema.String,
  runId: Schema.String,
  owner: Schema.Union([
    Schema.Struct({ email: Schema.NonEmptyString }),
    Schema.Struct({
      email: Schema.optionalKey(Schema.Never),
      customerId: Schema.NonEmptyString,
    }),
  ]),
  startDate: Schema.String,
  endDate: Schema.String,
  orderId: Schema.optional(Schema.String),
  reservationId: Schema.optional(Schema.String),
});

export type ReservationIntent = typeof reservationIntentSchema.Type;

const reservationJournalSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeReservationJournal = Schema.decodeUnknownResult(
  reservationJournalSchema
);
const hasPersistedIntentIds = Schema.is(
  Schema.Array(Schema.Struct({ id: Schema.String }))
);

// A journal has one worker owner. Serialize its fixture and intent writes too.
const pending = new Map<string, Promise<void>>();

export const writeReservationJournal = (
  path: string,
  value: object,
  intent?: ReservationIntent
): Promise<void> => {
  const previous = pending.get(path) ?? Promise.resolve();
  const write = previous.then(async () => {
    const existing = await readReservationJournal(path);
    const intents = existing?.reservationIntents ?? [];
    if (!hasPersistedIntentIds(intents))
      throw new Error("Invalid reservation intents");
    await writeJsonAtomically(path, {
      ...existing,
      ...value,
      reservationIntents: intent
        ? [...intents.filter((entry) => entry.id !== intent.id), intent]
        : intents,
    });
  });
  pending.set(path, write);
  return write.finally(() => {
    if (pending.get(path) === write) pending.delete(path);
  });
};

export const readReservationJournal = async (path: string) => {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const journal = decodeReservationJournal(value);
    if (Result.isFailure(journal)) {
      throw new Error("Invalid reservation journal");
    }
    return journal.success;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }
    throw cause;
  }
};
