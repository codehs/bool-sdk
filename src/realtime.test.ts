import { describe, expect, test } from "bun:test";
import { createDoorbell, type DoorbellDeps, type RealtimeMint } from "./realtime";
import type { BoolChangePayload } from "./client";

// The doorbell lifecycle drives everything through injected deps, so these
// tests exercise the full machine — mint, join, refresh, revocation, fallback,
// teardown — with zero sockets.

type FakeChannel = {
  topic: string;
  priv: boolean;
  joined: boolean;
  left: boolean;
  cb: ((p: BoolChangePayload) => void) | null;
  status: ((s: string) => void) | null;
};

function makeHarness(opts: { mints?: (RealtimeMint | null)[] } = {}) {
  const mints = [...(opts.mints ?? [])];
  const h = {
    channels: [] as FakeChannel[],
    authed: [] as string[],
    mintCalls: 0,
    scheduled: [] as { fn: () => void; ms: number; cancelled: boolean }[],
    /** Run the next pending refresh timer. */
    async fire() {
      const t = h.scheduled.find((s) => !s.cancelled && !(s as any).fired);
      if (!t) throw new Error("nothing scheduled");
      (t as any).fired = true;
      await t.fn();
      await tick();
    },
    ding(topic: string, payload: BoolChangePayload) {
      for (const ch of h.channels) {
        if (ch.topic === topic && ch.joined && !ch.left) ch.cb?.(payload);
      }
    },
    live: () => h.channels.filter((c) => c.joined && !c.left),
  };
  const deps: DoorbellDeps = {
    async mint() {
      h.mintCalls++;
      return mints.length ? mints.shift()! : null;
    },
    async setAuth(token) {
      h.authed.push(token);
    },
    channel(topic, { private: priv }) {
      const ch: FakeChannel = { topic, priv, joined: false, left: false, cb: null, status: null };
      h.channels.push(ch);
      return {
        onBroadcast(cb) {
          ch.cb = cb;
        },
        join(status) {
          ch.joined = true;
          ch.status = status;
        },
        leave() {
          ch.left = true;
        },
      };
    },
    legacyTopic: "bool:app_x",
    schedule(fn, ms) {
      const t = { fn: fn as () => void, ms, cancelled: false };
      h.scheduled.push(t);
      return t;
    },
    cancel(handle) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  };
  return { h, doorbell: createDoorbell(deps) };
}

const MINT: RealtimeMint = {
  token: "tok-1",
  expiresIn: 900,
  topics: { app: "bool:app_x:app", user: "bool:app_x:user:u1" },
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createDoorbell: the private path", () => {
  test("mints, presents the wristband, joins app + user rooms privately", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT] });
    doorbell.subscribe(() => {});
    await tick();
    expect(h.authed).toEqual(["tok-1"]);
    expect(h.live().map((c) => [c.topic, c.priv])).toEqual([
      ["bool:app_x:app", true],
      ["bool:app_x:user:u1", true],
    ]);
  });

  test("anonymous mint (no user topic) joins the app room only", async () => {
    const { h, doorbell } = makeHarness({
      mints: [{ ...MINT, topics: { app: "bool:app_x:app", user: null } }],
    });
    doorbell.subscribe(() => {});
    await tick();
    expect(h.live().map((c) => c.topic)).toEqual(["bool:app_x:app"]);
  });

  test("payloads from either room reach every listener (one shared doorbell)", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT] });
    const a: BoolChangePayload[] = [];
    const b: BoolChangePayload[] = [];
    doorbell.subscribe((p) => a.push(p));
    doorbell.subscribe((p) => b.push(p));
    await tick();
    expect(h.mintCalls).toBe(1); // second subscriber reuses the running doorbell
    h.ding("bool:app_x:app", { table: "todos", op: "INSERT", id: "1", row: { id: "1" } });
    h.ding("bool:app_x:user:u1", { table: "notes", op: "UPDATE", id: "2" });
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[0]!.row).toEqual({ id: "1" });
  });
});

describe("createDoorbell: refresh & revocation", () => {
  test("re-mints at ~75% of the TTL and re-presents the new wristband", async () => {
    const { h, doorbell } = makeHarness({
      mints: [MINT, { ...MINT, token: "tok-2" }],
    });
    doorbell.subscribe(() => {});
    await tick();
    expect(h.scheduled[0]!.ms).toBe(900 * 1000 * 0.75);
    await h.fire();
    expect(h.authed).toEqual(["tok-1", "tok-2"]);
    // channels stay up — setAuth re-auths the connection, no rejoin
    expect(h.live().length).toBe(2);
    // and the next refresh is scheduled
    expect(h.scheduled.length).toBe(2);
  });

  test("a refused re-mint (revoked access) silences the private rooms and falls back", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT] }); // second mint → null
    const got: BoolChangePayload[] = [];
    doorbell.subscribe((p) => got.push(p));
    await tick();
    await h.fire();
    // private rooms left; only the public legacy channel remains
    const live = h.live();
    expect(live.map((c) => [c.topic, c.priv])).toEqual([["bool:app_x", false]]);
    // late payloads on the torn-down private room reach nobody
    h.ding("bool:app_x:app", { table: "todos", op: "INSERT", id: "9" });
    expect(got).toHaveLength(0);
  });

  test("a nonsense TTL is clamped so refresh can't melt into a mint loop", async () => {
    const { h, doorbell } = makeHarness({ mints: [{ ...MINT, expiresIn: 1 }] });
    doorbell.subscribe(() => {});
    await tick();
    expect(h.scheduled[0]!.ms).toBe(30_000);
  });
});

describe("createDoorbell: fallback & teardown", () => {
  test("no wristband desk (mint null) → legacy public channel", async () => {
    const { h, doorbell } = makeHarness({ mints: [null] });
    const got: BoolChangePayload[] = [];
    doorbell.subscribe((p) => got.push(p));
    await tick();
    expect(h.authed).toHaveLength(0);
    expect(h.live().map((c) => [c.topic, c.priv])).toEqual([["bool:app_x", false]]);
    h.ding("bool:app_x", { table: "todos", op: "DELETE", id: "3" });
    expect(got).toHaveLength(1);
  });

  // Regression: Supabase Realtime injects its own message-uuid `id` into any
  // broadcast payload that lacks one. On the row-data-free public channel that
  // uuid looks exactly like a row id to the live store, which would keyed-fetch
  // a nonexistent row and silently swallow the change. Missing `id` is the
  // signal that triggers a full reload — so the legacy path must discard it.
  test("legacy payloads are stripped to {table, op} — no injected id survives", async () => {
    const { h, doorbell } = makeHarness({ mints: [null] });
    const got: BoolChangePayload[] = [];
    doorbell.subscribe((p) => got.push(p));
    await tick();
    h.ding("bool:app_x", {
      table: "todos",
      op: "INSERT",
      id: "a-realtime-message-uuid",
      row: { id: "should-not-appear" },
    } as BoolChangePayload);
    expect(got).toEqual([{ table: "todos", op: "INSERT" }]);
    expect(got[0]!.id).toBeUndefined();
    expect(got[0]!.row).toBeUndefined();
  });

  test("private payloads keep id and row (only the legacy channel is stripped)", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT] });
    const got: BoolChangePayload[] = [];
    doorbell.subscribe((p) => got.push(p));
    await tick();
    h.ding("bool:app_x:app", { table: "todos", op: "INSERT", id: "row-1", row: { id: "row-1" } });
    expect(got[0]!.id).toBe("row-1");
    expect(got[0]!.row).toEqual({ id: "row-1" });
  });

  test("a refused private join degrades to the public ping (never a dead app)", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT] });
    doorbell.subscribe(() => {});
    await tick();
    h.channels[0]!.status!("CHANNEL_ERROR");
    expect(h.live().map((c) => [c.topic, c.priv])).toEqual([["bool:app_x", false]]);
  });

  test("last unsubscribe tears everything down; a late mint resolution no-ops", async () => {
    let release!: (m: RealtimeMint) => void;
    const slowMint = new Promise<RealtimeMint>((r) => (release = r));
    const h = {
      channels: [] as FakeChannel[],
      authed: [] as string[],
    };
    const doorbell = createDoorbell({
      mint: () => slowMint as Promise<RealtimeMint | null>,
      setAuth: async (t) => void h.authed.push(t),
      channel(topic, { private: priv }) {
        const ch: FakeChannel = { topic, priv, joined: false, left: false, cb: null, status: null };
        h.channels.push(ch);
        return {
          onBroadcast() {},
          join() {
            ch.joined = true;
          },
          leave() {
            ch.left = true;
          },
        };
      },
      legacyTopic: "bool:app_x",
    });
    const off = doorbell.subscribe(() => {});
    off(); // teardown while the mint is still in flight
    release(MINT);
    await tick();
    expect(h.authed).toHaveLength(0); // orphaned continuation did nothing
    expect(h.channels).toHaveLength(0);
  });

  test("resubscribing after teardown starts a fresh doorbell", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT, { ...MINT, token: "tok-2" }] });
    const off = doorbell.subscribe(() => {});
    await tick();
    off();
    expect(h.live()).toHaveLength(0);
    doorbell.subscribe(() => {});
    await tick();
    expect(h.authed).toEqual(["tok-1", "tok-2"]);
    expect(h.live()).toHaveLength(2);
  });
});
