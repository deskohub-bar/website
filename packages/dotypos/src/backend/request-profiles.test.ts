import { expect, test } from "bun:test";
import type {
  DotyposConditionalWriteFailure,
  DotyposReadFailure,
  DotyposRequest,
  DotyposUncertain,
  DotyposWriteFailure,
} from "../errors";
import type {
  DotyposReplayUncertainty,
  DotyposRequestFailure,
} from "./request-profiles";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

test("request failure types follow each request's profile, unions included", () => {
  const checks = {
    read: true satisfies Equals<
      DotyposRequestFailure<"reservation.get">,
      DotyposReadFailure
    >,
    conditional: true satisfies Equals<
      DotyposRequestFailure<"reservation.patch">,
      DotyposConditionalWriteFailure
    >,
    write: true satisfies Equals<
      DotyposRequestFailure<"reservation.delete">,
      DotyposWriteFailure
    >,
    readOrConditional: true satisfies Equals<
      DotyposRequestFailure<"reservation.get" | "reservation.patch">,
      DotyposConditionalWriteFailure
    >,
    anyRequest: true satisfies Equals<
      DotyposRequestFailure<DotyposRequest>,
      DotyposConditionalWriteFailure
    >,
    replay: true satisfies Equals<
      DotyposReplayUncertainty<"customer.fill">,
      DotyposUncertain
    >,
    noReplay: true satisfies Equals<
      DotyposReplayUncertainty<"customer.get">,
      never
    >,
    replayOrNot: true satisfies Equals<
      DotyposReplayUncertainty<"customer.fill" | "customer.get">,
      DotyposUncertain
    >,
  };

  expect(Object.values(checks).every(Boolean)).toBe(true);
});
