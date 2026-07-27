import { describe, expect, test } from "bun:test";
import type { BoolChangePayload } from "./client.js";
import type { EntityHandler, FilterQuery, SortSpec } from "./entities.js";
import {
  compareBySort,
  LiveEntityStore,
  matchesFilter,
  type EntityRow,
} from "./live.js";

// ---------------------------------------------------------------------------
// Harness: a fake entity handler with a controllable server-side row set and
// manual promise resolution, so response ordering (the racy part) is exact.
// ---------------------------------------------------------------------------

type Row = EntityRow & { title?: string; done?: boolean; rank?: number | null };

function deferred<V>() {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHarness(initial: Row[] = []) {
  const rows = new Map(initial.map((r) => [r.id, { ...r }]));
  const listeners = new Set<(p: BoolChangePayload) => void>();
  const calls: { list: number; filter: FilterQuery[]; creates: Partial<Row>[] } = {
    list: 0,
    filter: [],
    creates: [],
  };
  // When set, the next list/filter call parks on this deferred instead of
  // resolving immediately (then clears, so later calls auto-resolve).
  let gate: ReturnType<typeof deferred<Row[]>> | null = null;

  const visible = () => [...rows.values()].map((r) => ({ ...r }));
  const handler = {
    async list() {
      calls.list++;
      if (gate) {
        const g = gate;
        gate = null;
        return g.promise;
      }
      return visible();
    },
    async filter(q: FilterQuery) {
      calls.filter.push(q);
      if (gate) {
        const g = gate;
        gate = null;
        return g.promise;
      }
      // Only the by-id shape the store issues needs to work here.
      const ids = q.id as string[] | undefined;
      return visible().filter((r) => !ids || ids.includes(r.id));
    },
    async get(id: string) {
      const r = rows.get(id);
      if (!r) throw new Error("not found");
      return { ...r };
    },
    async create(v: Partial<Row>) {
      calls.creates.push(v);
      const row = { ...v, id: v.id as string } as Row;
      rows.set(row.id, row);
      return { ...row };
    },
    async update(id: string, v: Partial<Row>) {
      const row = { ...rows.get(id)!, ...v, id };
      rows.set(id, row);
      return { ...row };
    },
    async delete(id: string) {
      rows.delete(id);
      return { success: true };
    },
    subscribe(cb: (p: BoolChangePayload) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  } as unknown as EntityHandler<Row>;

  return {
    handler,
    rows,
    calls,
    ding(p: BoolChangePayload) {
      for (const l of listeners) l(p);
    },
    gateNextLoad() {
      gate = deferred<Row[]>();
      return gate;
    },
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// Past the 50ms coalesce window, plus a beat for the keyed fetch to settle.
const settle = () => tick(70);

// ---------------------------------------------------------------------------
// matchesFilter — mirrors the server translation, incl. SQL null semantics
// ---------------------------------------------------------------------------

describe("matchesFilter", () => {
  const row = { id: "1", status: "active", count: 10, tags: ["a", "b"], archived_at: null };

  test("scalar equality, null, and array (IN) shorthands", () => {
    expect(matchesFilter(row, { status: "active" })).toBe(true);
    expect(matchesFilter(row, { status: "done" })).toBe(false);
    expect(matchesFilter(row, { archived_at: null })).toBe(true);
    expect(matchesFilter(row, { status: null })).toBe(false);
    expect(matchesFilter(row, { status: ["active", "paused"] })).toBe(true);
    expect(matchesFilter(row, { status: ["done"] })).toBe(false);
  });

  test("comparison operators", () => {
    expect(matchesFilter(row, { count: { $gte: 10 } })).toBe(true);
    expect(matchesFilter(row, { count: { $gt: 10 } })).toBe(false);
    expect(matchesFilter(row, { count: { $lt: 11, $gte: 10 } })).toBe(true);
    expect(matchesFilter(row, { count: { $ne: 5 } })).toBe(true);
    expect(matchesFilter(row, { count: { $in: [1, 10] } })).toBe(true);
    expect(matchesFilter(row, { count: { $nin: [1, 10] } })).toBe(false);
  });

  test("SQL three-valued logic: a NULL column fails comparisons, like PostgREST", () => {
    expect(matchesFilter(row, { archived_at: { $ne: "x" } })).toBe(false);
    expect(matchesFilter(row, { archived_at: { $gt: "2020" } })).toBe(false);
    expect(matchesFilter(row, { archived_at: { $exists: false } })).toBe(true);
    expect(matchesFilter(row, { count: { $exists: true } })).toBe(true);
    // absent key behaves like NULL
    expect(matchesFilter(row, { missing: { $eq: null } })).toBe(true);
    expect(matchesFilter(row, { missing: { $ne: 1 } })).toBe(false);
  });

  test("$regex, $all, $not", () => {
    expect(matchesFilter(row, { status: { $regex: "^act" } })).toBe(true);
    expect(matchesFilter(row, { status: { $regex: "^x" } })).toBe(false);
    expect(matchesFilter(row, { tags: { $all: ["a", "b"] } })).toBe(true);
    expect(matchesFilter(row, { tags: { $all: ["a", "z"] } })).toBe(false);
    expect(matchesFilter(row, { count: { $not: { $eq: 5 } } })).toBe(true);
    expect(matchesFilter(row, { count: { $not: { $gte: 5 } } })).toBe(false);
  });

  test("$and / $or / $nor", () => {
    expect(matchesFilter(row, { $and: [{ status: "active" }, { count: { $gt: 5 } }] })).toBe(true);
    expect(matchesFilter(row, { $or: [{ status: "done" }, { count: 10 }] })).toBe(true);
    expect(matchesFilter(row, { $or: [{ status: "done" }, { count: 11 }] })).toBe(false);
    expect(matchesFilter(row, { $nor: [{ status: "done" }] })).toBe(true);
    expect(matchesFilter(row, { $nor: [{ status: "active" }] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compareBySort — postgres default order, stable ties
// ---------------------------------------------------------------------------

describe("compareBySort", () => {
  const rows: Row[] = [
    { id: "b", rank: 2 },
    { id: "a", rank: 1 },
    { id: "c", rank: null },
    { id: "d", rank: 2 },
  ];

  test("ascending puts nulls last; descending puts them first", () => {
    expect([...rows].sort(compareBySort("rank")).map((r) => r.id)).toEqual(["a", "b", "d", "c"]);
    expect([...rows].sort(compareBySort("-rank")).map((r) => r.id)).toEqual(["c", "b", "d", "a"]);
  });

  test("ties break on id for stability", () => {
    const sorted = [...rows].sort(compareBySort("rank"));
    expect(sorted[1]!.id).toBe("b");
    expect(sorted[2]!.id).toBe("d");
  });
});

// ---------------------------------------------------------------------------
// LiveEntityStore — the state machine
// ---------------------------------------------------------------------------

describe("LiveEntityStore: loading + dings", () => {
  test("initial load populates the snapshot and clears loading", async () => {
    const h = makeHarness([{ id: "1", title: "one" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();
    expect(store.getSnapshot().loading).toBe(false);
    expect(store.getSnapshot().data.map((r) => r.id)).toEqual(["1"]);
    stop();
  });

  test("a burst of dings coalesces into ONE keyed fetch, not N reloads", async () => {
    const h = makeHarness([{ id: "1" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();
    expect(h.calls.list).toBe(1);

    for (let i = 2; i <= 20; i++) h.rows.set(String(i), { id: String(i) });
    for (let i = 2; i <= 20; i++) h.ding({ table: "t", op: "INSERT", id: String(i) });
    await settle();

    expect(h.calls.list).toBe(1); // never re-listed
    expect(h.calls.filter.length).toBe(1); // ONE by-id fetch for the whole burst
    expect((h.calls.filter[0]!.id as string[]).length).toBe(19);
    expect(store.getSnapshot().data.length).toBe(20);
    stop();
  });

  test("LEADING EDGE: a lone ding reconciles immediately, not after the window", async () => {
    const h = makeHarness([{ id: "1" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    h.rows.set("2", { id: "2" });
    h.ding({ table: "t", op: "INSERT", id: "2" });
    await tick(15); // well under the 50ms window
    expect(store.getSnapshot().data.length).toBe(2); // already applied
    stop();
  });

  test("LEADING EDGE: a burst right after a pass still collapses into one more fetch", async () => {
    const h = makeHarness([{ id: "1" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    // First ding fires a pass immediately...
    h.rows.set("2", { id: "2" });
    h.ding({ table: "t", op: "INSERT", id: "2" });
    await tick(10);
    const after1 = h.calls.filter.length;
    expect(after1).toBe(1);
    // ...then a burst inside the window batches into exactly one more pass.
    for (let i = 3; i <= 12; i++) {
      h.rows.set(String(i), { id: String(i) });
      h.ding({ table: "t", op: "INSERT", id: String(i) });
    }
    await settle();
    expect(h.calls.filter.length).toBe(2);
    expect(store.getSnapshot().data.length).toBe(12);
    stop();
  });

  test("DELETE dings apply locally with zero fetches", async () => {
    const h = makeHarness([{ id: "1" }, { id: "2" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    h.ding({ table: "t", op: "DELETE", id: "2" });
    await settle();

    expect(store.getSnapshot().data.map((r) => r.id)).toEqual(["1"]);
    expect(h.calls.filter.length).toBe(0);
    expect(h.calls.list).toBe(1);
    stop();
  });

  test("a ding with no id (old trigger) degrades to one coalesced full reload", async () => {
    const h = makeHarness([{ id: "1" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    h.rows.set("2", { id: "2" });
    h.ding({ table: "t", op: "INSERT" });
    h.ding({ table: "t", op: "INSERT" });
    h.ding({ table: "t", op: "INSERT" });
    await settle();

    expect(h.calls.list).toBe(2); // initial + ONE reload for the burst
    expect(store.getSnapshot().data.length).toBe(2);
    stop();
  });

  test("a row carried ON the ding applies with zero fetches (private-channel forward-compat)", async () => {
    const h = makeHarness([{ id: "1" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    h.ding({ table: "t", op: "INSERT", id: "2", row: { id: "2", title: "pushed" } });
    await settle();

    expect(store.getSnapshot().data.find((r) => r.id === "2")?.title).toBe("pushed");
    expect(h.calls.filter.length).toBe(0);
    expect(h.calls.list).toBe(1);
    stop();
  });

  test("an id fetched but not returned (deleted / RLS-hidden) leaves the view", async () => {
    const h = makeHarness([{ id: "1" }, { id: "2" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    h.rows.delete("2"); // row vanishes server-side before the keyed fetch lands
    h.ding({ table: "t", op: "UPDATE", id: "2" });
    await settle();

    expect(store.getSnapshot().data.map((r) => r.id)).toEqual(["1"]);
    stop();
  });

  test("filtered view: a changed row that stops matching drops out; one that starts matching drops in", async () => {
    const h = makeHarness([
      { id: "1", done: false },
      { id: "2", done: true },
    ]);
    const store = new LiveEntityStore<Row>(h.handler, { filter: { done: false } });
    const stop = store.start();
    await tick();

    h.rows.set("1", { id: "1", done: true }); // leaves the filter
    h.rows.set("2", { id: "2", done: false }); // enters it
    h.ding({ table: "t", op: "UPDATE", id: "1" });
    h.ding({ table: "t", op: "UPDATE", id: "2" });
    await settle();

    expect(store.getSnapshot().data.map((r) => r.id)).toEqual(["2"]);
    stop();
  });
});

describe("LiveEntityStore: response ordering (the anti-rewind guard)", () => {
  test("a stale full-load response landing after a newer one is DROPPED", async () => {
    const h = makeHarness([{ id: "1", title: "fresh" }]);
    const store = new LiveEntityStore<Row>(h.handler);

    const stale = h.gateNextLoad(); // first load parks
    const stop = store.start();
    await tick();
    await store.refetch(); // second load resolves immediately with "fresh"
    expect(store.getSnapshot().data[0]!.title).toBe("fresh");

    stale.resolve([{ id: "1", title: "stale" }]); // now the FIRST response lands
    await tick();

    expect(store.getSnapshot().data[0]!.title).toBe("fresh"); // not rewound
    stop();
  });
});

describe("LiveEntityStore: optimistic mutations", () => {
  test("create renders immediately, settles to the committed row", async () => {
    const h = makeHarness();
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    const p = store.create({ title: "new" });
    expect(store.getSnapshot().data.length).toBe(1); // before the await
    const created = await p;
    expect(created?.title).toBe("new");
    expect(store.getSnapshot().data.length).toBe(1); // still one row (same id)
    expect(store.getSnapshot().error).toBeNull();
    stop();
  });

  test("an optimistic row SURVIVES a full refetch that doesn't include it yet", async () => {
    const h = makeHarness([{ id: "1" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    // Park the create so its overlay stays in-flight...
    let releaseCreate!: () => void;
    const origCreate = h.handler.create.bind(h.handler);
    h.handler.create = (async (v: Partial<Row>) => {
      await new Promise<void>((r) => (releaseCreate = r));
      return origCreate(v);
    }) as typeof h.handler.create;

    const p = store.create({ id: "opt-1", title: "mine" });
    await tick();
    // ...and refetch while it's pending: the server list lacks opt-1.
    await store.refetch();
    const ids = store.getSnapshot().data.map((r) => r.id);
    expect(ids).toContain("opt-1"); // did NOT flicker away

    releaseCreate();
    await p;
    expect(store.getSnapshot().data.map((r) => r.id)).toContain("opt-1");
    stop();
  });

  test("create failure rolls back and surfaces the error without throwing", async () => {
    const h = makeHarness();
    h.handler.create = (async () => {
      throw new Error("insert failed");
    }) as typeof h.handler.create;
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    const created = await store.create({ title: "doomed" });
    expect(created).toBeNull();
    expect(store.getSnapshot().data.length).toBe(0); // rolled back
    expect((store.getSnapshot().error as Error).message).toBe("insert failed");
    stop();
  });

  test("update overlays instantly and rolls back on failure", async () => {
    const h = makeHarness([{ id: "1", title: "old" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    // success path
    await store.update("1", { title: "new" });
    expect(store.getSnapshot().data[0]!.title).toBe("new");

    // failure path
    h.handler.update = (async () => {
      throw new Error("update failed");
    }) as typeof h.handler.update;
    const updated = await store.update("1", { title: "doomed" });
    expect(updated).toBeNull();
    expect(store.getSnapshot().data[0]!.title).toBe("new"); // restored
    stop();
  });

  test("remove hides instantly and restores on failure", async () => {
    const h = makeHarness([{ id: "1" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    h.handler.delete = (async () => {
      throw new Error("delete failed");
    }) as typeof h.handler.delete;
    const p = store.remove("1");
    expect(store.getSnapshot().data.length).toBe(0); // hidden immediately
    expect(await p).toBe(false);
    expect(store.getSnapshot().data.length).toBe(1); // restored
    stop();
  });

  test("the doorbell echo of your own write reconciles to a no-op (no duplicates)", async () => {
    const h = makeHarness();
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();

    const created = await store.create({ title: "mine" });
    h.ding({ table: "t", op: "INSERT", id: created!.id }); // the echo
    await settle();

    expect(store.getSnapshot().data.length).toBe(1);
    stop();
  });
});

describe("LiveEntityStore: view shaping", () => {
  test("sort order is maintained across delta applies", async () => {
    const h = makeHarness([
      { id: "1", rank: 1 },
      { id: "3", rank: 3 },
    ]);
    const store = new LiveEntityStore<Row>(h.handler, { sort: "rank" as SortSpec });
    const stop = store.start();
    await tick();

    h.rows.set("2", { id: "2", rank: 2 });
    h.ding({ table: "t", op: "INSERT", id: "2" });
    await settle();

    expect(store.getSnapshot().data.map((r) => r.id)).toEqual(["1", "2", "3"]);
    stop();
  });

  test("an explicit limit trims the view after sorting", async () => {
    const h = makeHarness([
      { id: "1", rank: 1 },
      { id: "2", rank: 2 },
    ]);
    const store = new LiveEntityStore<Row>(h.handler, { sort: "rank", limit: 2 });
    const stop = store.start();
    await tick();

    h.rows.set("0", { id: "0", rank: 0 });
    h.ding({ table: "t", op: "INSERT", id: "0" });
    await settle();

    expect(store.getSnapshot().data.map((r) => r.id)).toEqual(["0", "1"]);
    stop();
  });

  test("stop() detaches: dings after teardown do nothing", async () => {
    const h = makeHarness([{ id: "1" }]);
    const store = new LiveEntityStore<Row>(h.handler);
    const stop = store.start();
    await tick();
    stop();

    h.ding({ table: "t", op: "DELETE", id: "1" });
    await settle();
    expect(store.getSnapshot().data.length).toBe(1); // untouched
    expect(h.calls.filter.length).toBe(0);
  });
});
