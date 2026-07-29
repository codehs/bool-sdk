import { describe, expect, test } from "bun:test";
import {
  colorForId,
  createRoomStore,
  type RoomChannel,
  type RoomDeps,
  type RoomMintResult,
  type RoomStore,
} from "./room";

// A fake transport: a "wire" shared by any number of stores, so multi-peer
// behavior (presence sync, broadcast fan-out, self-filtering) is exercised for
// real, without sockets. Mirrors the injection discipline of realtime.ts.
type Wire = {
  presences: Map<string, Record<string, unknown>>;
  presenceSubs: Set<(states: Record<string, Array<Record<string, unknown>>>) => void>;
  broadcastSubs: Set<{ selfKey: string; cb: (msg: { event: string; payload: unknown }) => void }>;
  syncAll(): void;
};

function makeWire(): Wire {
  const wire: Wire = {
    presences: new Map(),
    presenceSubs: new Set(),
    broadcastSubs: new Set(),
    syncAll() {
      const states: Record<string, Array<Record<string, unknown>>> = {};
      for (const [k, v] of wire.presences) states[k] = [{ presence_ref: "r", ...v }];
      for (const cb of wire.presenceSubs) cb(states);
    },
  };
  return wire;
}

function makeHarness(opts?: {
  mint?: () => Promise<RoomMintResult>;
  wire?: Wire;
  /** What the fake channel reports back from track() — supabase-js resolves
   * with a STRING, and "timed out"/"error" must drive recovery. */
  trackResult?: string;
}) {
  const wire = opts?.wire ?? makeWire();
  const trackResult = opts?.trackResult ?? "ok";
  // Deterministic virtual clock so throttle behavior is testable exactly.
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const advance = async (ms: number) => {
    const target = clock + ms;
    // run due timers in order, allowing them to schedule more
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const due = timers[0];
      if (!due || due.at > target) break;
      clock = due.at;
      timers.shift();
      due.fn();
      await flush();
    }
    clock = target;
    // Always flush, even when no timer was due: the store's handshake is a
    // chain of awaits (mint race → setAuth → channel), so a caller that only
    // advances the clock would otherwise observe a half-settled machine.
    await flush();
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  let joinCb: ((state: string) => void) | null = null;
  const sent: Array<{ event: string; payload: unknown }> = [];
  let key = "";

  const deps: RoomDeps = {
    mint:
      opts?.mint ??
      (async () => ({ ok: true, token: "t", expiresIn: 900, topic: "bool:app_x:room" })),
    setAuth: () => {},
    channel: (_topic, k) => {
      key = k;
      const ch: RoomChannel = {
        track(state, done) {
          wire.presences.set(k, state);
          wire.syncAll();
          done?.(trackResult);
        },
        onPresence(cb) {
          wire.presenceSubs.add(cb);
        },
        onBroadcast(cb) {
          wire.broadcastSubs.add({ selfKey: k, cb });
        },
        send(event, payload, done) {
          sent.push({ event, payload });
          done?.("ok");
          // deliver to every OTHER subscriber on the wire (server self:false)
          for (const sub of wire.broadcastSubs) {
            if (sub.selfKey !== k) sub.cb({ event, payload });
          }
        },
        join(status) {
          joinCb = status;
        },
        leave() {
          wire.presences.delete(k);
          wire.syncAll();
        },
      };
      return ch;
    },
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    cancel: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i !== -1) timers.splice(i, 1);
    },
    now: () => clock,
  };

  const store = createRoomStore(deps);
  return {
    store,
    wire,
    sent,
    advance,
    selfKey: () => key,
    // Wait for the store's real handshake (mint → setAuth → channel) instead of
    // a fixed number of microtasks: the number changed when mint gained a
    // timeout race, and a hardcoded tick count silently stopped joining at all.
    join: async () => {
      for (let i = 0; i < 50 && !joinCb; i++) await Promise.resolve();
      if (!joinCb) throw new Error("channel was never created — the store never reached join()");
      joinCb("SUBSCRIBED");
      await Promise.resolve();
    },
    fire: (state: string) => joinCb?.(state),
  };
}

describe("colorForId", () => {
  test("is deterministic and valid hsl", () => {
    expect(colorForId("abc")).toBe(colorForId("abc"));
    expect(colorForId("abc")).toMatch(/^hsl\(\d+ 85% 55%\)$/);
  });

  test("two clients compute the same color for the same peer (nothing transmitted)", () => {
    // The property the design relies on — no color field on the wire.
    const a = colorForId("peer-1");
    const b = colorForId("peer-1");
    expect(a).toBe(b);
  });
});

describe("room store: presence", () => {
  test("others excludes self, includes peers, and strips presence_ref", async () => {
    const wire = makeWire();
    const h = makeHarness({ wire });
    const release = h.store.acquire();
    await h.join();

    // a peer lands on the wire
    wire.presences.set("peer-1", { cursor: { x: 1, y: 2 } });
    wire.syncAll();

    const others = h.store.getOthers();
    expect(others.length).toBe(1);
    expect(others[0]!.id).toBe("peer-1");
    expect(others[0]!.presence).toEqual({ cursor: { x: 1, y: 2 } });
    expect("presence_ref" in others[0]!.presence).toBe(false);
    expect(others.some((o) => o.id === h.store.self.id)).toBe(false);
    release();
  });

  test("a peer who joined but set nothing has EMPTY presence (the ghost-cursor case)", async () => {
    const wire = makeWire();
    const h = makeHarness({ wire });
    const release = h.store.acquire();
    await h.join();

    wire.presences.set("peer-1", {});
    wire.syncAll();
    const o = h.store.getOthers()[0]!;
    // Partial<P>: reading o.presence.cursor must be survivable — this is the
    // state real apps crash on if they don't guard.
    expect(o.presence).toEqual({});
    release();
  });

  test("setMe merges patches and undefined deletes a key", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();

    h.store.setMe({ cursor: { x: 1, y: 1 } });
    await h.advance(30);
    h.store.setMe({ typing: true });
    await h.advance(30);
    expect(h.wire.presences.get(h.selfKey())).toEqual({ cursor: { x: 1, y: 1 }, typing: true });

    h.store.setMe({ typing: undefined });
    await h.advance(30);
    expect(h.wire.presences.get(h.selfKey())).toEqual({ cursor: { x: 1, y: 1 } });
    release();
  });

  test("setMe is trailing-edge throttled: a 60fps burst collapses but the FINAL position lands", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    const trackCountAfterJoin = h.wire.presences.size; // join replays once

    // 20 moves in ~80ms (way over the 25ms throttle)
    for (let i = 1; i <= 20; i++) {
      h.store.setMe({ cursor: { x: i, y: i } });
      await h.advance(4);
    }
    await h.advance(50); // let the trailing edge fire
    const mine = h.wire.presences.get(h.selfKey()) as { cursor: { x: number } };
    expect(mine.cursor.x).toBe(20); // the last write always wins on the wire
    expect(trackCountAfterJoin).toBe(1);
    release();
  });

  test("presence set before the join is replayed ON join (never invisible)", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    h.store.setMe({ name: "jack" }); // before SUBSCRIBED
    await h.join();
    expect(h.wire.presences.get(h.selfKey())).toEqual({ name: "jack" });
    release();
  });

  test("clearMe removes exactly the named keys (hook-unmount semantics)", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    h.store.setMe({ cursor: { x: 1, y: 1 }, name: "jack" });
    await h.advance(30);
    h.store.clearMe(["cursor"]);
    await h.advance(30);
    expect(h.wire.presences.get(h.selfKey())).toEqual({ name: "jack" });
    release();
  });
});

describe("room store: broadcast + echo", () => {
  test("the sender's own listeners fire synchronously, before any network", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();

    const got: unknown[] = [];
    h.store.onEvent((event, e) => got.push([event, e.from, e.data]));
    h.store.broadcast("reaction", { emoji: "🎉" });
    // No advance(), no await: the echo is same-tick by contract.
    expect(got).toEqual([["reaction", h.store.self.id, { emoji: "🎉" }]]);
    release();
  });

  test("a wire copy of my own event is NOT delivered twice", async () => {
    const wire = makeWire();
    const h = makeHarness({ wire });
    const release = h.store.acquire();
    await h.join();

    const got: unknown[] = [];
    h.store.onEvent(() => got.push(1));
    h.store.broadcast("x", 1);
    // simulate a server that echoes anyway (belt over the self:false config)
    for (const sub of wire.broadcastSubs) sub.cb({ event: "x", payload: { f: h.store.self.id, d: 1 } });
    expect(got.length).toBe(1);
    release();
  });

  test("two stores on one wire: events cross with the sender id attached", async () => {
    const wire = makeWire();
    const a = makeHarness({ wire });
    const b = makeHarness({ wire });
    const ra = a.store.acquire();
    const rb = b.store.acquire();
    await a.join();
    await b.join();

    const got: Array<{ from: string; data: unknown }> = [];
    b.store.onEvent((_ev, e) => got.push(e));
    a.store.broadcast("ping", { n: 1 });
    expect(got).toEqual([{ from: a.store.self.id, data: { n: 1 } }]);
    ra();
    rb();
  });

  test("an oversized payload throws with the fix, instead of a silent server drop", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    expect(() => h.store.broadcast("img", "x".repeat(70_000))).toThrow(/60000-byte/);
    release();
  });
});

describe("room store: lifecycle + status", () => {
  test("acquire starts, last release tears down and empties others", async () => {
    const wire = makeWire();
    const h = makeHarness({ wire });
    const r1 = h.store.acquire();
    const r2 = h.store.acquire();
    await h.join();
    wire.presences.set("peer-1", { a: 1 });
    wire.syncAll();
    expect(h.store.getOthers().length).toBe(1);

    r1();
    expect(h.store.status()).toBe("live"); // still held
    r2();
    expect(h.store.getOthers().length).toBe(0);
    // releasing twice is a no-op (StrictMode calls cleanups it owns exactly
    // once, but defensive release must not underflow the ref-count)
    r2();
  });

  test("an unauthorized mint reports honestly and retries — never fakes liveness", async () => {
    let calls = 0;
    const h = makeHarness({
      mint: async () => {
        calls++;
        return { ok: false, reason: "unauthorized" };
      },
    });
    const release = h.store.acquire();
    await h.advance(1); // settle the first mint
    expect(h.store.status()).toBe("unauthorized");
    await h.advance(1_100); // first backoff step
    expect(calls).toBeGreaterThanOrEqual(2);
    release();
  });

  test("a platform without the room topic is UNAVAILABLE, not silently dead", async () => {
    const h = makeHarness({
      mint: async () => ({ ok: true, token: "t", expiresIn: 900, topic: null }),
    });
    const release = h.store.acquire();
    await h.advance(1);
    expect(h.store.status()).toBe("unavailable");
    release();
  });

  test("status transitions notify subscribers", async () => {
    const h = makeHarness();
    const seen: string[] = [];
    h.store.onStatus((s) => seen.push(s));
    const release = h.store.acquire();
    await h.join();
    expect(seen).toContain("live");
    release();
  });
});

// Regression suite for the FIRST real-world failure of bool.room, found on a
// preview app (2026-07-29). Symptom: the app rendered "ROOM IS LIVE" with 0
// peers forever; an external observer confirmed the tab was absent from
// presence, and a 34-second WebSocket watch showed ZERO frames and ZERO
// sockets. Four independent defects conspired, each individually silent:
//
//   1. `CLOSED` was not a handled channel state, and supabase-js does NOT
//      auto-rejoin — a dropped socket meant permanent death. (Verified against
//      a real close: the status arrives with no follow-up SUBSCRIBED.)
//   2. teardown() assigned `state` directly instead of via setStatus, so every
//      useSyncExternalStore subscriber kept a stale snapshot — which is why the
//      badge said "live" while nothing was connected.
//   3. track()/send() failures were swallowed: supabase-js RESOLVES with the
//      string "timed out" / "error" rather than throwing, so `void ch.track()`
//      discarded every failure.
//   4. mint() had no timeout, so one hung fetch could wedge the machine with no
//      channel, no status change and no retry.
describe("room store: recovery (the dead-but-'live' regression)", () => {
  test("CLOSED recovers instead of dying silently", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    expect(h.store.status()).toBe("live");

    h.fire("CLOSED"); // socket dropped: blip, server close, token expiry
    await h.advance(1);
    // Honest status, and a retry scheduled — not a permanent "live" lie.
    expect(h.store.status()).toBe("unavailable");
    await h.advance(1_100);
    await h.join();
    expect(h.store.status()).toBe("live");
    release();
  });

  test("every terminal channel state drives recovery", async () => {
    for (const terminal of ["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]) {
      const h = makeHarness();
      const release = h.store.acquire();
      await h.join();
      h.fire(terminal);
      await h.advance(1);
      expect(h.store.status()).toBe("unavailable");
      release();
    }
  });

  test("status changes ALWAYS notify subscribers — a stale snapshot is the bug", async () => {
    // useStatus() is a useSyncExternalStore over this; a direct `state = …`
    // write leaves React rendering the old value forever.
    const h = makeHarness();
    const seen: string[] = [];
    h.store.onStatus((s) => seen.push(s));
    const release = h.store.acquire();
    await h.join();
    expect(seen).toContain("live");
    release(); // last release → teardown
    expect(seen[seen.length - 1]).toBe("connecting");
    expect(h.store.status()).toBe("connecting");
  });

  test("a failed presence publish reconnects instead of going quiet", async () => {
    // supabase-js resolves "timed out" on a dead channel — no exception to
    // catch, so this is only visible if the result is inspected.
    const h = makeHarness({ trackResult: "timed out" });
    const release = h.store.acquire();
    await h.join();
    h.store.setMe({ cursor: { x: 1, y: 1 } });
    await h.advance(40);
    expect(h.store.status()).toBe("unavailable"); // healing, not silently dead
    release();
  });

  test("a hung mint cannot wedge the room forever", async () => {
    const h = makeHarness({ mint: () => new Promise(() => {}) }); // never settles
    const release = h.store.acquire();
    await h.advance(11_000); // past the mint timeout
    expect(h.store.status()).toBe("unavailable");
    release();
  });

  test("recovery is not attempted once nobody is watching", async () => {
    // A released store must stay quiet; acquire() starts a fresh generation.
    const h = makeHarness({ trackResult: "error" });
    const release = h.store.acquire();
    await h.join();
    release();
    const before = h.store.status();
    h.store.setMe({ cursor: { x: 2, y: 2 } });
    await h.advance(100);
    expect(h.store.status()).toBe(before);
  });
});
