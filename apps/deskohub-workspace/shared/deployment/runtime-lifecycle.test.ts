import { afterEach, describe, expect, mock, test } from "bun:test";
import { channel } from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import { Effect } from "effect";

// Stands in for Vercel's request context: records what reaches `waitUntil`.
const vercelWaits: Promise<unknown>[] = [];
const vercelFunctions = await import("@vercel/functions");
mock.module("@vercel/functions", () => ({
  ...vercelFunctions,
  waitUntil: (promise: Promise<unknown>) => {
    vercelWaits.push(promise);
  },
}));

const {
  installRuntimeShutdown,
  keepRuntimeAliveUntil,
  onRuntimeShutdown,
  shutdownRuntime,
  trackRuntimeWork,
} = await import("./runtime-lifecycle");

const lifecycleKey = Symbol.for("@deskohub-workspace/runtime-lifecycle");

afterEach(() => {
  vercelWaits.length = 0;
  Reflect.deleteProperty(globalThis, lifecycleKey);
});

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const shortBudget = {
  drain: "50 millis",
  flush: "50 millis",
  close: "50 millis",
} as const;

/** Installs the shutdown without signal listeners and records exits. */
const installForTest = (budget?: typeof shortBudget) => {
  const exits: number[] = [];
  const shutdown = installRuntimeShutdown({
    run: (effect) => Effect.runPromise(effect),
    exit: (code) => {
      exits.push(code);
    },
    budget,
    signals: [],
  });
  return { exits, shutdown };
};

describe("keepRuntimeAliveUntil", () => {
  test("hands the work to Vercel's waitUntil unchanged", () => {
    const work = Promise.resolve("done");

    keepRuntimeAliveUntil(work);

    expect(vercelWaits).toEqual([work]);
  });

  test("tracks nothing for shutdown until a container installs it", async () => {
    const order: string[] = [];
    const work = deferred();
    keepRuntimeAliveUntil(work.promise);
    onRuntimeShutdown({
      name: "flush",
      stage: "flush",
      run: async () => {
        order.push("flush");
      },
    });

    await Effect.runPromise(shutdownRuntime(shortBudget));

    expect(order).toEqual(["flush"]);
    work.resolve();
  });
});

describe("trackRuntimeWork", () => {
  test("leaves Vercel's waitUntil alone and tracks nothing before a container installs its shutdown", async () => {
    const work = deferred();
    trackRuntimeWork(work.promise);
    const { exits, shutdown } = installForTest();

    await shutdown();

    expect(vercelWaits).toEqual([]);
    expect(exits).toEqual([0]);
  });

  test("makes an installed container wait for the work before it exits", async () => {
    const { exits, shutdown } = installForTest();
    const work = deferred();
    trackRuntimeWork(work.promise);

    const stopped = shutdown();
    await Bun.sleep(10);
    expect(exits).toEqual([]);
    work.resolve();
    await stopped;

    expect(vercelWaits).toEqual([]);
    expect(exits).toEqual([0]);
  });
});

describe("installRuntimeShutdown", () => {
  test("drains in-flight work, flushes, then closes, and exits cleanly", async () => {
    const { exits, shutdown } = installForTest();
    const order: string[] = [];
    const request = deferred();
    const lateWork = deferred();
    keepRuntimeAliveUntil(
      request.promise.then(() => {
        order.push("request");
        // Work a finishing request starts is drained too.
        keepRuntimeAliveUntil(
          lateWork.promise.then(() => {
            order.push("late work");
          })
        );
        setTimeout(lateWork.resolve, 5);
      })
    );
    onRuntimeShutdown({
      name: "database",
      stage: "close",
      run: async () => {
        order.push("close");
      },
    });
    onRuntimeShutdown({
      name: "telemetry",
      stage: "flush",
      run: async () => {
        order.push("flush");
      },
    });

    const shuttingDown = shutdown();
    setTimeout(request.resolve, 5);
    await shuttingDown;

    expect(order).toEqual(["request", "late work", "flush", "close"]);
    expect(exits).toEqual([0]);
  });

  test("keeps the budget when work or hooks never settle or fail", async () => {
    const { exits, shutdown } = installForTest(shortBudget);
    const ran: string[] = [];
    keepRuntimeAliveUntil(new Promise(() => undefined));
    onRuntimeShutdown({
      name: "hanging flush",
      stage: "flush",
      run: () => new Promise(() => undefined),
    });
    onRuntimeShutdown({
      name: "failing flush",
      stage: "flush",
      run: () => Promise.reject(new Error("synthetic flush failure")),
    });
    onRuntimeShutdown({
      name: "close",
      stage: "close",
      run: async () => {
        ran.push("close");
      },
    });

    const startedAt = performance.now();
    await shutdown();

    expect(ran).toEqual(["close"]);
    expect(exits).toEqual([0]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("runs one shutdown however many signals arrive", async () => {
    const { exits, shutdown } = installForTest(shortBudget);
    let flushes = 0;
    onRuntimeShutdown({
      name: "telemetry",
      stage: "flush",
      run: async () => {
        flushes += 1;
      },
    });

    await Promise.all([shutdown(), shutdown()]);

    expect(flushes).toBe(1);
    expect(exits).toEqual([0]);
  });

  test("a hook registered again under its name replaces the earlier one", async () => {
    installForTest(shortBudget);
    const ran: string[] = [];
    for (const instance of [
      "first module instance",
      "second module instance",
    ]) {
      onRuntimeShutdown({
        name: "telemetry",
        stage: "flush",
        run: async () => {
          ran.push(instance);
        },
      });
    }

    await Effect.runPromise(shutdownRuntime(shortBudget));

    expect(ran).toEqual(["second module instance"]);
  });
  test("lets an HTTP request in flight at the signal complete before it exits", async () => {
    const { exits, shutdown } = installForTest();
    // Node publishes each request its HTTP server starts on this channel;
    // Bun's server does not, so the test publishes the request itself. The
    // OCI image check exercises Node's own server.
    const response = Object.assign(new EventEmitter(), { closed: false });
    channel("http.server.request.start").publish({
      request: new EventEmitter(),
      response,
    });

    const stopped = shutdown();
    await Bun.sleep(20);
    expect(exits).toEqual([]);

    response.closed = true;
    response.emit("close");
    await stopped;
    expect(exits).toEqual([0]);
  });

  test("exits without waiting on a request message that has no response", async () => {
    const { exits, shutdown } = installForTest();
    channel("http.server.request.start").publish({
      request: new EventEmitter(),
    });

    await shutdown();
    expect(exits).toEqual([0]);
  });
});
