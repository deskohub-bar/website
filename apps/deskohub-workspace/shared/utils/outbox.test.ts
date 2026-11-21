import { describe, expect, test } from "bun:test";
import { createOutbox } from "./outbox";

describe("createOutbox", () => {
  test("holds items until a sink attaches, then delivers them in order", () => {
    const outbox = createOutbox<number>({ capacity: 3 });
    const delivered: number[] = [];

    outbox.post(1);
    outbox.post(2);
    expect(delivered).toEqual([]);

    outbox.attach((item) => delivered.push(item));
    outbox.post(3);

    expect(delivered).toEqual([1, 2, 3]);
  });

  test("holds items again after the sink detaches", () => {
    const outbox = createOutbox<number>({ capacity: 3 });
    const first: number[] = [];
    const second: number[] = [];

    const detach = outbox.attach((item) => first.push(item));
    outbox.post(1);
    detach();
    outbox.post(2);
    outbox.attach((item) => second.push(item));

    expect(first).toEqual([1]);
    expect(second).toEqual([2]);
  });

  test("keeps a newer sink attached when an older one detaches", () => {
    const outbox = createOutbox<number>({ capacity: 3 });
    const newer: number[] = [];

    const detachOlder = outbox.attach(() => undefined);
    outbox.attach((item) => newer.push(item));
    detachOlder();
    outbox.post(1);

    expect(newer).toEqual([1]);
  });

  test("keeps the earliest pending items up to capacity", () => {
    const outbox = createOutbox<number>({ capacity: 2 });
    const delivered: number[] = [];

    outbox.post(1);
    outbox.post(2);
    outbox.post(3);
    outbox.attach((item) => delivered.push(item));

    expect(delivered).toEqual([1, 2]);
  });

  test("drops pending items when they are discarded", () => {
    const outbox = createOutbox<number>({ capacity: 2 });
    const delivered: number[] = [];

    outbox.post(1);
    outbox.discard();
    outbox.post(2);
    outbox.attach((item) => delivered.push(item));

    expect(delivered).toEqual([2]);
  });

  test("loses only the item a sink throws on", () => {
    const outbox = createOutbox<number>({ capacity: 3 });
    const delivered: number[] = [];

    outbox.post(1);
    outbox.post(2);
    outbox.attach((item) => {
      if (item === 1) throw new Error("synthetic sink failure");
      delivered.push(item);
    });
    outbox.post(3);

    expect(delivered).toEqual([2, 3]);
  });
});
