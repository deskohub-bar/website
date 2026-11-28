import { expect, test } from "bun:test";
import type { CustomerPassPurchaseStatus } from "@deskohub/workspace-customer-api";
import { type Duration, Effect, Layer, Option, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { TestClock } from "effect/testing";
import { AccountReadBudget } from "../../../customer-api/account-read-budget";
import {
  AccountExitFence,
  makeAccountExitFence,
} from "../../../customer-api/account-scoped-storage";
import {
  CustomerAccountScope,
  CustomerApi,
} from "../../../customer-api/customer-api.service";
import { customerDataRuntime } from "../../../customer-api/customer-data-runtime";
import { nativeCustomerApiTransport } from "../../../customer-api/platform-transports";
import {
  makeCustomerDataRegistry,
  remainingAccountReads,
} from "../../../customer-api/testing/customer-data-test-registry";
import {
  fakeCustomerDataLayer,
  makeFakeDevice,
} from "../../../customer-api/testing/fake-customer-data";
import {
  FakeWorkspace,
  fakeWorkspaceOrigin,
} from "../../../customer-api/testing/fake-workspace";
import { eventually, quietly } from "../../../testing/eventually";
import {
  makePassPurchaseStatusAtoms,
  type PassPurchaseStatusCheck,
} from "./pass-purchase-status-state";

const orderId = "836223a1-29fd-4c4f-b876-49782ae18eda";
const errorTags = {
  401: "CustomerSessionRequired",
  404: "CustomerPassNotFound",
  429: "CustomerRateLimited",
} as const;
type TestAnswer =
  | CustomerPassPurchaseStatus["status"]
  | keyof typeof errorTags
  | "truncated-json";

function setup({
  answers,
  afterPayment = true,
  replyDelay = 0,
}: {
  readonly answers: readonly [TestAnswer, ...TestAnswer[]];
  readonly afterPayment?: boolean;
  readonly replyDelay?: Duration.Input;
}) {
  const calls: Array<{ readonly method: string; readonly url: string }> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const answer = answers[calls.length] ?? answers.at(-1) ?? answers[0];
      calls.push({ method: request.method, url: url.href });
      if (answer === "truncated-json") {
        return HttpClientResponse.fromWeb(
          request,
          new Response('{"status":', {
            headers: { "content-type": "application/json" },
          })
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        typeof answer === "number"
          ? Response.json({ _tag: errorTags[answer] }, { status: answer })
          : Response.json({
              orderId,
              status: answer,
              productKind: "entry-pack",
              tier: "open-space",
              statusPath: `/cs-CZ/rezervace/stav/${orderId}`,
            } satisfies CustomerPassPurchaseStatus)
      );
    }).pipe(Effect.tap(() => Effect.sleep(replyDelay)))
  );
  const device = makeFakeDevice();
  const fence = makeAccountExitFence();
  const workspace = FakeWorkspace.forKind("linked");
  const registry = makeCustomerDataRegistry(
    Layer.mergeAll(
      fakeCustomerDataLayer({
        workspace,
        device,
        fence: Layer.succeed(AccountExitFence, fence),
      }),
      Layer.fresh(CustomerApi.Default).pipe(
        Layer.provide(
          nativeCustomerApiTransport({
            apiOrigin: fakeWorkspaceOrigin,
            readSessionCookie: Effect.succeed("deskohub.session_token=sample"),
          })
        ),
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
      ),
      TestClock.layer()
    )
  );
  const foreground = Atom.make(true);
  const atoms = makePassPurchaseStatusAtoms(
    orderId,
    "cs-CZ",
    afterPayment,
    foreground
  );
  const unmountRuntime = registry.mount(customerDataRuntime);
  const unmountStatus = registry.mount(atoms.status);
  const fromRuntime = <A, E>(
    effect: Effect.Effect<A, E, AccountReadBudget | CustomerAccountScope>
  ) =>
    Effect.runPromise(
      Effect.flatMap(
        AtomRegistry.getResult(customerDataRuntime)(registry),
        (context) => Effect.provideContext(effect, context)
      )
    );
  const current = () =>
    Option.getOrUndefined(AsyncResult.value(registry.get(atoms.status)));
  const settled = (
    count: number,
    status:
      | CustomerPassPurchaseStatus["status"]
      | (typeof errorTags)[keyof typeof errorTags]
      | "SchemaError"
  ) =>
    Effect.runPromise(
      eventually(
        () => {
          const progress = current();
          if (calls.length !== count || progress?.reading || !progress?.outcome)
            return false;
          return Result.match(progress.outcome, {
            onSuccess: (purchase) => purchase.status === status,
            onFailure: (error) => error._tag === status,
          });
        },
        () => JSON.stringify({ calls: calls.length, current: current() })
      ).pipe(Effect.andThen(quietly))
    );
  return {
    calls,
    device,
    focus: (focused: boolean) => registry.set(atoms.focused, focused),
    foreground: (active: boolean) => registry.set(foreground, active),
    refresh: (kind: PassPurchaseStatusCheck = "manual") =>
      registry.update(atoms.refresh, ({ revision }) => ({
        revision: revision + 1,
        kind,
      })),
    fromRuntime,
    current,
    settled,
    remaining: () => remainingAccountReads(registry),
    closeSession: () =>
      fromRuntime(
        Effect.flatMap(Effect.service(CustomerAccountScope), fence.close)
      ),
    dispose: () => {
      unmountStatus();
      unmountRuntime();
      registry.dispose();
    },
  };
}

test("reads the owned pass by UUID and locale, then polls only until settlement", async () => {
  const status = setup({ answers: ["pending", "checking", "paid"] });
  try {
    status.focus(true);
    await status.settled(1, "pending");
    expect(status.calls).toEqual([
      {
        method: "GET",
        url: `${fakeWorkspaceOrigin}/api/customer/passes/purchases/${orderId}?locale=cs-CZ`,
      },
    ]);
    await status.fromRuntime(TestClock.adjust("3 seconds"));
    await status.settled(2, "checking");
    await status.fromRuntime(TestClock.adjust("3 seconds"));
    await status.settled(3, "paid");
    await status.fromRuntime(TestClock.adjust("5 minutes"));
    expect(status.calls).toHaveLength(3);
    expect(await status.remaining()).toBe(37);
  } finally {
    status.dispose();
  }
});

test.each([
  [401, "CustomerSessionRequired"],
  [404, "CustomerPassNotFound"],
] as const)(
  "retains the confirmed status on transient failure and clears it on %d",
  async (accessFailure, tag) => {
    const status = setup({
      answers: ["paid", 429, accessFailure],
      afterPayment: false,
    });
    try {
      status.focus(true);
      await status.settled(1, "paid");
      status.refresh();
      await status.settled(2, "CustomerRateLimited");
      expect(status.current()?.confirmed?.status).toBe("paid");
      status.refresh();
      await status.settled(3, tag);
      expect(status.current()?.confirmed).toBeUndefined();
    } finally {
      status.dispose();
    }
  }
);

test("foreground changes do not replay a manual read when a status is already known", async () => {
  const status = setup({
    answers: ["failed", "paid"],
    afterPayment: false,
    replyDelay: "1 second",
  });
  try {
    status.focus(true);
    const sent = (count: number) =>
      Effect.runPromise(
        eventually(() => status.calls.length === count).pipe(
          Effect.andThen(quietly)
        )
      );
    await sent(1);
    await status.fromRuntime(TestClock.adjust("1 second"));
    await status.settled(1, "failed");
    status.refresh();
    await sent(2);
    status.foreground(false);
    await status.fromRuntime(TestClock.adjust("1 second"));
    status.foreground(true);
    await Effect.runPromise(
      eventually(() => status.current()?.reading === false)
    );
    await status.fromRuntime(TestClock.adjust("1 minute"));
    expect(status.calls).toHaveLength(2);
    expect(status.current()?.confirmed?.status).toBe("failed");
    expect(status.current()?.outcome).toBeUndefined();
    status.refresh();
    await sent(3);
    await status.fromRuntime(TestClock.adjust("1 second"));
    await status.settled(3, "paid");
  } finally {
    status.dispose();
  }
});

test("foregrounding recovers the first read when there is no status to keep", async () => {
  const status = setup({
    answers: ["pending"],
    afterPayment: false,
    replyDelay: "1 second",
  });
  try {
    status.focus(true);
    const sent = (count: number) =>
      Effect.runPromise(
        eventually(() => status.calls.length === count).pipe(
          Effect.andThen(quietly)
        )
      );
    await sent(1);
    status.foreground(false);
    await status.fromRuntime(TestClock.adjust("1 second"));
    status.foreground(true);
    await sent(2);
    await status.fromRuntime(TestClock.adjust("1 second"));
    await status.settled(2, "pending");
  } finally {
    status.dispose();
  }
});

test("a normal visit stays manual, and a 401 asks auth to recheck", async () => {
  const status = setup({ answers: ["pending", 401], afterPayment: false });
  try {
    status.focus(true);
    await status.settled(1, "pending");
    await status.fromRuntime(TestClock.adjust("5 minutes"));
    expect(status.calls).toHaveLength(1);
    status.refresh();
    await status.settled(2, "CustomerSessionRequired");
    expect(status.device.sessionChecks).toBe(1);
  } finally {
    status.dispose();
  }
});

test("backgrounding interrupts the wait and a low budget leaves manual refresh available", async () => {
  const status = setup({ answers: ["pending", "paid"] });
  try {
    status.focus(true);
    await status.settled(1, "pending");
    status.foreground(false);
    await status.fromRuntime(TestClock.adjust("30 seconds"));
    expect(status.calls).toHaveLength(1);

    await status.fromRuntime(
      Effect.flatMap(Effect.service(AccountReadBudget), (budget) =>
        Effect.repeat(budget.spend, { times: 31 })
      )
    );
    expect(await status.remaining()).toBe(7);
    status.foreground(true);
    await status.fromRuntime(TestClock.adjust("5 minutes"));
    expect(status.calls).toHaveLength(1);
    status.refresh();
    await status.settled(2, "paid");
  } finally {
    status.dispose();
  }
});

test("a previous account session cannot refresh an order after exit", async () => {
  const status = setup({ answers: ["pending"] });
  try {
    status.focus(true);
    await status.settled(1, "pending");
    expect(await status.closeSession()).toBe(true);
    status.refresh();
    await status.settled(1, "CustomerSessionRequired");
  } finally {
    status.dispose();
  }
});

test("does not publish a successful order read after the account session exits", async () => {
  const status = setup({ answers: ["paid"], replyDelay: "1 second" });
  try {
    status.focus(true);
    await Effect.runPromise(
      eventually(() => status.calls.length === 1).pipe(Effect.andThen(quietly))
    );
    expect(await status.closeSession()).toBe(true);
    await status.fromRuntime(TestClock.adjust("1 second"));
    await status.settled(1, "CustomerSessionRequired");
  } finally {
    status.dispose();
  }
});

test("a new payment attempt restarts settlement polling after the last attempt failed", async () => {
  const status = setup({ answers: ["failed", "pending", "paid"] });
  try {
    status.focus(true);
    await status.settled(1, "failed");
    await status.fromRuntime(TestClock.adjust("30 seconds"));
    expect(status.calls).toHaveLength(1);
    status.refresh("after-payment");
    await status.settled(2, "pending");
    await status.fromRuntime(TestClock.adjust("3 seconds"));
    await status.settled(3, "paid");
  } finally {
    status.dispose();
  }
});

test("an uncertain write warning clears once settlement confirms a refund", async () => {
  const status = setup({ answers: ["failed", "checking", "refunded", 429] });
  try {
    status.focus(true);
    await status.settled(1, "failed");
    status.refresh("unconfirmed");
    await status.settled(2, "checking");
    expect(status.current()?.unconfirmed).toBe(true);
    await status.fromRuntime(TestClock.adjust("3 seconds"));
    await status.settled(3, "refunded");
    expect(status.current()?.unconfirmed).toBe(false);
    expect(status.current()?.confirmed?.status).toBe("refunded");
    status.refresh();
    await status.settled(4, "CustomerRateLimited");
    expect(status.current()?.unconfirmed).toBe(false);
    expect(status.current()?.confirmed?.status).toBe("refunded");
  } finally {
    status.dispose();
  }
});

test.each([
  ["refunded", "refunded"],
  ["CustomerSessionRequired", 401],
  ["CustomerPassNotFound", 404],
] as const)(
  "a truncated status response leaves payment uncertain until a fresh %s response",
  async (expected, resolution) => {
    const status = setup({
      answers: ["failed", "truncated-json", resolution],
      afterPayment: false,
    });
    try {
      status.focus(true);
      await status.settled(1, "failed");
      status.refresh("unconfirmed");
      await status.settled(2, "SchemaError");
      expect(status.current()?.unconfirmed).toBe(true);
      status.refresh();
      await status.settled(3, expected);
      expect(status.current()?.unconfirmed).toBe(false);
    } finally {
      status.dispose();
    }
  }
);

test("persistent pending payment uses a bounded number of automatic reads", async () => {
  const status = setup({ answers: ["pending"] });
  try {
    status.focus(true);
    await status.settled(1, "pending");
    const delays = [3, 3, 5, 5, 10, 15, 20, 30, 60];
    for (const [index, seconds] of delays.entries()) {
      await status.fromRuntime(TestClock.adjust(`${seconds} seconds`));
      await status.settled(index + 2, "pending");
    }
    await status.fromRuntime(TestClock.adjust("5 minutes"));
    expect(status.calls).toHaveLength(10);
    status.refresh();
    await status.settled(11, "pending");
    await status.fromRuntime(TestClock.adjust("5 minutes"));
    expect(status.calls).toHaveLength(11);
  } finally {
    status.dispose();
  }
});
