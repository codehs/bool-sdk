import { describe, expect, test } from "bun:test";
import {
  colorForId,
  createRoomStore,
  throttleForPeers,
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
  // Wake signals are injected the same way timers are, so "reconnects the
  // instant the tab comes back" is testable without a real document.
  const wakeCbs = new Set<() => void>();
  let mintCalls = 0;

  const baseMint =
    opts?.mint ??
    (async (): Promise<RoomMintResult> => ({
      ok: true,
      token: "t",
      expiresIn: 900,
      topic: "bool:app_x:room",
    }));

  const deps: RoomDeps = {
    mint: () => {
      mintCalls++;
      return baseMint();
    },
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
    wake: (cb) => {
      wakeCbs.add(cb);
      return () => wakeCbs.delete(cb);
    },
  };

  const store = createRoomStore(deps);
  return {
    store,
    wire,
    sent,
    advance,
    selfKey: () => key,
    mintCalls: () => mintCalls,
    /** Simulate the tab/network coming back. */
    wake: () => {
      for (const cb of [...wakeCbs]) cb();
    },
    wakeSubs: () => wakeCbs.size,
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

  // These four assert at the only altitude that survived the transport change:
  // what a PEER on the same wire observes. (They used to peek at the wire's
  // presence map — which went blank the day setMe state moved from presence,
  // where the server throttles cursor-frequency writes to death, to broadcast.)
  test("setMe merges patches and undefined deletes a key", async () => {
    const wire = makeWire();
    const a = makeHarness({ wire });
    const b = makeHarness({ wire });
    const releaseA = a.store.acquire();
    await a.join();
    const releaseB = b.store.acquire();
    await b.join();

    a.store.setMe({ cursor: { x: 1, y: 1 } });
    await a.advance(30);
    a.store.setMe({ typing: true });
    await a.advance(30);
    const seen = () => b.store.getOthers().find((o) => o.id === a.store.self.id)!.presence;
    expect(seen()).toEqual({ cursor: { x: 1, y: 1 }, typing: true });

    a.store.setMe({ typing: undefined });
    await a.advance(30);
    expect(seen()).toEqual({ cursor: { x: 1, y: 1 } });
    releaseA();
    releaseB();
  });

  test("setMe is trailing-edge throttled: a 60fps burst collapses but the FINAL position lands", async () => {
    const wire = makeWire();
    const a = makeHarness({ wire });
    const b = makeHarness({ wire });
    const releaseA = a.store.acquire();
    await a.join();
    const releaseB = b.store.acquire();
    await b.join();
    const sendsBefore = a.sent.filter((s) => s.event === "~me").length;

    // 20 moves in ~80ms (way over the 25ms throttle)
    for (let i = 1; i <= 20; i++) {
      a.store.setMe({ cursor: { x: i, y: i } });
      await a.advance(4);
    }
    await a.advance(50); // let the trailing edge fire
    const sends = a.sent.filter((s) => s.event === "~me").length - sendsBefore;
    expect(sends).toBeLessThanOrEqual(6); // ~80ms / 25ms + trailing edge
    expect(sends).toBeGreaterThan(0);
    const seen = b.store.getOthers().find((o) => o.id === a.store.self.id)!
      .presence as { cursor: { x: number } };
    expect(seen.cursor.x).toBe(20); // the last write always wins on the wire
    releaseA();
    releaseB();
  });

  test("state set before the join is replayed ON join (never invisible)", async () => {
    const wire = makeWire();
    const b = makeHarness({ wire });
    const releaseB = b.store.acquire();
    await b.join();
    const a = makeHarness({ wire });
    const releaseA = a.store.acquire();
    a.store.setMe({ name: "jack" }); // before SUBSCRIBED
    await a.join();
    await a.advance(5);
    const seen = b.store.getOthers().find((o) => o.id === a.store.self.id)!.presence;
    expect(seen).toEqual({ name: "jack" });
    releaseA();
    releaseB();
  });

  test("a late joiner is hydrated by the existing peers' re-send (jittered)", async () => {
    // The reverse of the test above: A already has state, THEN B joins. B has
    // missed A's ~me broadcasts entirely; A must re-send when it sees a new
    // member, or B renders A as an empty ghost until A's next move.
    const wire = makeWire();
    const a = makeHarness({ wire });
    const releaseA = a.store.acquire();
    await a.join();
    a.store.setMe({ name: "jack" });
    await a.advance(30);

    const b = makeHarness({ wire });
    const releaseB = b.store.acquire();
    await b.join();
    // before A's hydration fires, B knows A only as a member
    await a.advance(301); // past the max hydrate jitter
    const seen = b.store.getOthers().find((o) => o.id === a.store.self.id)!.presence;
    expect(seen).toEqual({ name: "jack" });
    releaseA();
    releaseB();
  });

  test("clearMe removes exactly the named keys (hook-unmount semantics)", async () => {
    const wire = makeWire();
    const a = makeHarness({ wire });
    const b = makeHarness({ wire });
    const releaseA = a.store.acquire();
    await a.join();
    const releaseB = b.store.acquire();
    await b.join();
    a.store.setMe({ cursor: { x: 1, y: 1 }, name: "jack" });
    await a.advance(30);
    a.store.clearMe(["cursor"]);
    await a.advance(30);
    const seen = b.store.getOthers().find((o) => o.id === a.store.self.id)!.presence;
    expect(seen).toEqual({ name: "jack" });
    releaseA();
    releaseB();
  });

  test("app events can never squat the SDK's reserved wire namespace", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    expect(() => h.store.broadcast("~me", { fake: true })).toThrow(/reserved for the SDK/);
    expect(() => h.store.broadcast("~anything", 1)).toThrow(/reserved/);
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

describe("bool.room waking up", () => {
  test("a wake reconnects immediately instead of waiting out the backoff", async () => {
    // The failure this fixes, observed on a real deployed app: a backgrounded
    // tab loses its socket, honestly reports OFFLINE, and then sits on the
    // [1s, 5s, 15s, 60s] ladder. Coming back to a page that says "offline" for
    // half a minute is indistinguishable from broken.
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    expect(h.store.status()).toBe("live");

    // Burn through the early rungs so the next scheduled retry is far away.
    for (let i = 0; i < 3; i++) {
      h.fire("CLOSED");
      await h.advance(20_000);
    }
    h.fire("CLOSED");
    await h.advance(0);
    expect(h.store.status()).toBe("unavailable");
    const beforeWake = h.mintCalls();

    // No clock advance at all: the reconnect must not be waiting on a timer.
    h.wake();
    await h.advance(0);
    expect(h.mintCalls()).toBe(beforeWake + 1);
    await h.join();
    expect(h.store.status()).toBe("live");
    release();
  });

  test("a wake while live does nothing (no churn on every tab focus)", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    const before = h.mintCalls();
    h.wake();
    await h.advance(0);
    expect(h.mintCalls()).toBe(before);
    expect(h.store.status()).toBe("live");
    release();
  });

  test("simultaneous wake signals coalesce into one reconnect", async () => {
    // focus + visibilitychange + online all fire on the same tab re-selection.
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    h.fire("CLOSED");
    await h.advance(0);
    const before = h.mintCalls();
    h.wake();
    h.wake();
    h.wake();
    await h.advance(0);
    expect(h.mintCalls()).toBe(before + 1);
    release();
  });

  test("a later wake still works once the coalescing window has passed", async () => {
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();
    h.fire("CLOSED");
    await h.advance(0);
    h.wake();
    await h.advance(0);
    const after = h.mintCalls();
    h.fire("CLOSED");
    await h.advance(600); // past WAKE_COALESCE_MS
    const beforeSecond = h.mintCalls();
    h.wake();
    await h.advance(0);
    expect(h.mintCalls()).toBe(beforeSecond + 1);
    expect(h.mintCalls()).toBeGreaterThan(after);
    release();
  });

  test("wake listeners are released with the last hook (no leak, no zombie)", async () => {
    const h = makeHarness();
    expect(h.wakeSubs()).toBe(0);
    const a = h.store.acquire();
    const b = h.store.acquire();
    await h.join();
    expect(h.wakeSubs()).toBe(1); // ref-counted, one subscription total
    a();
    expect(h.wakeSubs()).toBe(1);
    b();
    expect(h.wakeSubs()).toBe(0);

    // And a wake after full release must not resurrect anything.
    const before = h.mintCalls();
    h.wake();
    await h.advance(100);
    expect(h.mintCalls()).toBe(before);
  });
});

describe("bool.room broadcast size limit", () => {
  test("measures UTF-8 bytes, not UTF-16 code units", async () => {
    // `JSON.stringify(x).length` counts code units, so a payload of multi-byte
    // characters measured at a third of what it actually sends — waving through
    // an over-limit message for the server to drop silently, which is the exact
    // failure the guard exists to name.
    const h = makeHarness();
    const release = h.store.acquire();
    await h.join();

    // 25k emoji: 50k UTF-16 code units (under the 60k limit by the old check)
    // but 100k UTF-8 bytes (over it).
    const emoji = "🎉".repeat(25_000);
    expect(JSON.stringify({ f: "x", d: emoji }).length).toBeLessThan(60_000);
    expect(() => h.store.broadcast("party", emoji)).toThrow(/over the 60000-byte/);

    // Plain ASCII of the same code-unit length is genuinely under and allowed.
    expect(() => h.store.broadcast("party", "a".repeat(50_000))).not.toThrow();
    release();
  });
});

describe("bool.room surviving supabase's synchronous CLOSED", () => {
  // supabase's removeChannel fires the channel's own status callback with
  // CLOSED — synchronously, from inside leave(). Since the terminal-state
  // handler responds to CLOSED by tearing down (which leaves), the two used to
  // feed each other: teardown → leave → CLOSED → teardown → … a stack overflow
  // on every real network drop. Seen in production as an endless stream of
  // "Maximum call stack size exceeded" from a deployed cursor app.
  function makeSyncCloseHarness() {
    let joinCb: ((s: string) => void) | null = null;
    let channelsMade = 0;
    const timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let clock = 0;
    let nextId = 1;
    const deps: RoomDeps = {
      mint: async () => ({ ok: true, token: "t", expiresIn: 900, topic: "bool:x:room" }),
      setAuth: () => {},
      channel: (): RoomChannel => {
        channelsMade++;
        return {
          track: (_s, done) => done?.("ok"),
          onPresence: () => {},
          onBroadcast: () => {},
          send: () => {},
          join: (cb) => {
            joinCb = cb;
          },
          leave: () => {
            joinCb?.("CLOSED"); // what removeChannel actually does
          },
        };
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
      wake: () => () => {},
    };
    const store = createRoomStore(deps);
    const advance = async (ms: number) => {
      const target = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > target) break;
        clock = due.at;
        timers.shift();
        due.fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      clock = target;
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return {
      store,
      advance,
      fire: (s: string) => joinCb?.(s),
      channelsMade: () => channelsMade,
      join: async () => {
        for (let i = 0; i < 50 && !joinCb; i++) await Promise.resolve();
        joinCb!("SUBSCRIBED");
        await Promise.resolve();
      },
    };
  }

  test("a real drop does not recurse, and the room still recovers", async () => {
    const h = makeSyncCloseHarness();
    const release = h.store.acquire();
    await h.join();
    expect(h.store.status()).toBe("live");

    h.fire("CLOSED"); // pre-fix: RangeError, maximum call stack exceeded
    expect(h.store.status()).toBe("unavailable");

    // and recovery is intact: the retry rung reconnects a fresh channel
    const before = h.channelsMade();
    await h.advance(1_000);
    expect(h.channelsMade()).toBe(before + 1);
    await h.join();
    expect(h.store.status()).toBe("live");
    release();
  });

  test("release() with a live channel does not recurse either", async () => {
    const h = makeSyncCloseHarness();
    const release = h.store.acquire();
    await h.join();
    release(); // teardown → leave → sync CLOSED, on the unmount path
    expect(h.store.status()).toBe("connecting");
    // and nothing keeps retrying after teardown
    const before = h.channelsMade();
    await h.advance(120_000);
    expect(h.channelsMade()).toBe(before);
  });
});

describe("bool.room render economy", () => {
  test("a flood of ~me messages coalesces to ~one emit per frame", async () => {
    const wire = makeWire();
    const a = makeHarness({ wire });
    const b = makeHarness({ wire });
    const releaseA = a.store.acquire();
    await a.join();
    const releaseB = b.store.acquire();
    await b.join();

    let emits = 0;
    b.store.onOthers(() => emits++);
    // 12 updates land within one 16ms frame (setMe throttle is bypassed by
    // sending straight through the wire helper — we're testing B's inbound
    // side, not A's outbound throttle)
    for (let i = 1; i <= 12; i++) {
      a.store.setMe({ cursor: { x: i, y: i } });
      await a.advance(30); // A sends each one (past its own throttle)...
      await b.advance(1); // ...B absorbs them nearly back-to-back
    }
    await b.advance(20); // trailing edge
    // 12 inbound messages, spread over vastly fewer emits than messages
    expect(emits).toBeLessThan(12);
    expect(emits).toBeGreaterThan(0);
    const seen = b.store.getOthers().find((o) => o.id === a.store.self.id)!
      .presence as { cursor: { x: number } };
    expect(seen.cursor.x).toBe(12); // the final state always lands
    releaseA();
    releaseB();
  });

  test("a peer that did not change keeps its object identity across rebuilds", async () => {
    // The still person's <Cursor/> must not re-render because someone else
    // moved: React.memo relies on the peer object being the SAME reference.
    const wire = makeWire();
    const still = makeHarness({ wire });
    const mover = makeHarness({ wire });
    const observer = makeHarness({ wire });
    const r1 = still.store.acquire();
    await still.join();
    const r2 = mover.store.acquire();
    await mover.join();
    const r3 = observer.store.acquire();
    await observer.join();

    still.store.setMe({ name: "still" });
    await still.advance(30);
    await observer.advance(20);
    const before = observer.store.getOthers().find((o) => o.id === still.store.self.id);

    mover.store.setMe({ cursor: { x: 5, y: 5 } });
    await mover.advance(30);
    await observer.advance(20);
    const after = observer.store.getOthers().find((o) => o.id === still.store.self.id);
    expect(after).toBe(before); // same reference, not merely equal
    r1(); r2(); r3();
  });

  test("throttleForPeers stays at full rate through 8 people and degrades gently", () => {
    expect(throttleForPeers(0)).toBe(25); // alone
    expect(throttleForPeers(3)).toBe(25); // Jack + two colleagues
    expect(throttleForPeers(7)).toBe(28); // 8 people: ~full rate
    expect(throttleForPeers(9)).toBe(45); // 10 people ≈ 22Hz — smooth, not slideshow
    expect(throttleForPeers(14)).toBeLessThan(120); // 15 people ≥ ~8Hz
  });
});
