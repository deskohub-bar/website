import { describe, expect, test } from "bun:test";
import type { ReferralCode } from "@deskohub/workspace-customer-api";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import {
  RememberedReferralUpdate,
  rememberedReferralUpdate,
} from "./remembered-referral";
import {
  RememberedReferralCode,
  rememberedReferralStorageName,
} from "./remembered-referral.service";
import {
  failingAccountScopedStorage,
  inMemoryAccountScopedStorage,
} from "./remembered-referral.service.mock";

const code = "FRIEND-42" as ReferralCode;
const otherCode = "FRIEND-77" as ReferralCode;
const day = 24 * 60 * 60 * 1000;

const run = <A>(
  entries: Map<string, string>,
  program: Effect.Effect<A, never, RememberedReferralCode | TestClock.TestClock>
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          RememberedReferralCode.Default.pipe(
            Layer.provide(inMemoryAccountScopedStorage(entries))
          ),
          TestClock.layer()
        )
      )
    )
  );

const referrals = Effect.service(RememberedReferralCode);

describe("rememberedReferralUpdate", () => {
  test("a newly accepted code wins over the used-up one it replaces", () => {
    expect(
      rememberedReferralUpdate({
        rememberReferralCode: code,
        rememberedReferralCodeUsed: true,
      })
    ).toEqual(Option.some(RememberedReferralUpdate.Remember({ code })));
  });
});

describe("RememberedReferralCode", () => {
  test("remembers a code for the referral cookie's 30 days", async () => {
    const entries = new Map<string, string>();
    const found = await run(
      entries,
      Effect.gen(function* () {
        const remembered = yield* referrals;
        yield* remembered.remember(code);
        const fresh = yield* remembered.get;
        yield* TestClock.adjust(30 * day - 1);
        const lastMoment = yield* remembered.get;
        yield* TestClock.adjust(1);
        const expired = yield* remembered.get;
        return { fresh, lastMoment, expired };
      })
    );
    expect(found).toEqual({
      fresh: Option.some(code),
      lastMoment: Option.some(code),
      expired: Option.none(),
    });
    expect(entries.size).toBe(0);
  });

  test("applies a response's updates: replace, then forget", async () => {
    const entries = new Map<string, string>();
    const found = await run(
      entries,
      Effect.gen(function* () {
        const remembered = yield* referrals;
        yield* remembered.apply(RememberedReferralUpdate.Remember({ code }));
        yield* remembered.apply(
          RememberedReferralUpdate.Remember({ code: otherCode })
        );
        const replaced = yield* remembered.get;
        yield* remembered.apply(RememberedReferralUpdate.Forget());
        return { replaced, forgotten: yield* remembered.get };
      })
    );
    expect(found).toEqual({
      replaced: Option.some(otherCode),
      forgotten: Option.none(),
    });
  });

  test("drops an unreadable entry", async () => {
    const entries = new Map([[rememberedReferralStorageName, "{not json"]]);
    const found = await run(
      entries,
      Effect.flatMap(referrals, (remembered) => remembered.get)
    );
    expect(found).toEqual(Option.none());
    expect(entries.has(rememberedReferralStorageName)).toBe(false);
  });

  test("storage failures never fail the booking", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const remembered = yield* referrals;
        yield* remembered.remember(code);
        yield* remembered.forget;
        return yield* remembered.get;
      }).pipe(
        Effect.provide(
          RememberedReferralCode.Default.pipe(
            Layer.provide(failingAccountScopedStorage)
          )
        )
      )
    );
    expect(found).toEqual(Option.none());
  });
});
