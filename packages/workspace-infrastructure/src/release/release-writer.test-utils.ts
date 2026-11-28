import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { ReleaseOperation, ReleaseRecord } from "./release-record";
import { writerDigestOf } from "./release-writer";

/** A writer token tests hand to the stack as the lock holder's. */
export const testWriterToken = Redacted.make("test-writer-token");

/** The record with its writer lock held by `testWriterToken`. */
export const heldBy = (
  record: ReleaseRecord,
  operation: ReleaseOperation
): ReleaseRecord => ({
  ...record,
  writer: {
    holderDigest: writerDigestOf(testWriterToken),
    operation,
    acquiredAt: "2026-11-22T10:00:00Z",
    state: "held",
  },
});

/** A stack run started by the lock holder. */
export const runAsHolder = (generation: number | null) => ({
  writer: Option.some(testWriterToken),
  generation,
});
