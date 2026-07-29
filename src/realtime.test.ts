import { describe, expect, test } from "bun:test";
import {
  createDoorbell,
  type DoorbellDeps,
  type DoorbellStatus,
  type MintResult,
  type RealtimeMint,
} from "./realtime";
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

function makeHarness(
  opts: { mints?: MintResult[]; onStatus?: (s: DoorbellStatus) => void } = {},
) {
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
    /** Simulate the tab/network coming back. */
    wake: () => {
      for (const cb of [...wakeCbs]) cb();
    },
    wakeSubs: () => wakeCbs.size,
    clock: 0,
  };
  const wakeCbs = new Set<() => void>();
  const deps: DoorbellDeps = {
    async mint(): Promise<MintResult> {
      h.mintCalls++;
      return mints.length ? mints.shift()! : { ok: false, reason: "unauthorized" };
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
    schedule(fn, ms) {
      const t = { fn: fn as () => void, ms, cancelled: false };
      h.scheduled.push(t);
      return t;
    },
    cancel(handle) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    onStatus: opts.onStatus,
    now: () => h.clock,
    wake(cb) {
      wakeCbs.add(cb);
      return () => wakeCbs.delete(cb);
    },
  };
  return { h, doorbell: createDoorbell(deps) };
}

const RAW: RealtimeMint = {
  token: "tok-1",
  expiresIn: 900,
  topics: { app: "bool:app_x:app", user: "bool:app_x:user:u1" },
};
const MINT: MintResult = { ok: true, mint: RAW };
const ok = (m: Partial<RealtimeMint>): MintResult => ({ ok: true, mint: { ...RAW, ...m } });
const refused: MintResult = { ok: false, reason: "unauthorized" };
const down: MintResult = { ok: false, reason: "unavailable" };
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
      mints: [ok({ topics: { app: "bool:app_x:app", user: null } })],
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
    const { h, doorbell } = makeHarness({ mints: [MINT, ok({ token: "tok-2" })] });
    doorbell.subscribe(() => {});
    await tick();
    expect(h.scheduled[0]!.ms).toBe(900 * 1000 * 0.75);
    await h.fire();
    expect(h.authed).toEqual(["tok-1", "tok-2"]);
    // channels stay up — setAuth re-auths the connection, no rejoin
    expect(h.live().length).toBe(2);
  });

  test("a refused re-mint (revoked access) drops the rooms and reports unauthorized", async () => {
    // The TTL expiring IS the revocation mechanism: once the gateway stops
    // issuing wristbands the socket must go quiet, not keep listening.
    const { h, doorbell } = makeHarness({ mints: [MINT, refused] });
    const got: BoolChangePayload[] = [];
    doorbell.subscribe((p) => got.push(p));
    await tick();
    await h.fire();
    expect(h.live()).toHaveLength(0);
    expect(doorbell.status()).toBe("unauthorized");
    // late payloads on a torn-down room reach nobody
    h.ding("bool:app_x:app", { table: "todos", op: "INSERT", id: "9" });
    expect(got).toHaveLength(0);
  });

  test("a nonsense TTL is clamped so refresh can't melt into a mint loop", async () => {
    const { h, doorbell } = makeHarness({ mints: [ok({ expiresIn: 1 })] });
    doorbell.subscribe(() => {});
    await tick();
    expect(h.scheduled[0]!.ms).toBe(30_000);
  });
});

// There is NO public channel to fall back to — every topic is wristband-gated.
// So a failure is reported and retried, never disguised as liveness.
describe("createDoorbell: failure is surfaced, not disguised", () => {
  test("a refused mint reports unauthorized and joins nothing", async () => {
    const { h, doorbell } = makeHarness({ mints: [refused] });
    const got: BoolChangePayload[] = [];
    doorbell.subscribe((p) => got.push(p));
    await tick();
    expect(h.live()).toHaveLength(0);
    expect(h.authed).toHaveLength(0);
    expect(doorbell.status()).toBe("unauthorized");
    expect(got).toHaveLength(0);
  });

  test("an unreachable gateway reports unavailable — NOT unauthorized", async () => {
    // A public app admits every visitor, so a dropped request must never be
    // presented as "you aren't allowed to watch this".
    const { doorbell } = makeHarness({ mints: [down] });
    doorbell.subscribe(() => {});
    await tick();
    expect(doorbell.status()).toBe("unavailable");
  });

  test("status transitions are reported to the client", async () => {
    const seen: DoorbellStatus[] = [];
    const { h, doorbell } = makeHarness({ mints: [MINT] });
    // onStatus isn't part of makeHarness; assert via the accessor instead.
    expect(doorbell.status()).toBe("connecting");
    doorbell.subscribe(() => {});
    await tick();
    h.channels[0]!.status!("SUBSCRIBED");
    expect(doorbell.status()).toBe("live");
    void seen;
  });

  test("retries with capped backoff instead of hot-looping", async () => {
    const { h, doorbell } = makeHarness({ mints: [refused, refused, refused, refused, refused] });
    doorbell.subscribe(() => {});
    await tick();
    const delays: number[] = [h.scheduled[0]!.ms];
    for (let i = 0; i < 3; i++) {
      await h.fire();
      delays.push(h.scheduled.at(-1)!.ms);
    }
    expect(delays).toEqual([1_000, 5_000, 15_000, 60_000]);
    // and it keeps trying — a granted-later viewer eventually goes live
    expect(h.mintCalls).toBeGreaterThan(1);
  });

  test("a good join resets the backoff so a later blip starts quick again", async () => {
    const { h, doorbell } = makeHarness({ mints: [refused, MINT] });
    doorbell.subscribe(() => {});
    await tick();
    expect(h.scheduled[0]!.ms).toBe(1_000);
    await h.fire(); // second attempt mints fine
    h.channels[0]!.status!("SUBSCRIBED");
    expect(doorbell.status()).toBe("live");
    // a refused join now → backoff restarts at the first step
    h.channels[0]!.status!("CHANNEL_ERROR");
    expect(h.scheduled.at(-1)!.ms).toBe(1_000);
  });

  test("a refused private join tears down and retries (wristband/policy disagree)", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT] });
    doorbell.subscribe(() => {});
    await tick();
    h.channels[0]!.status!("CHANNEL_ERROR");
    expect(h.live()).toHaveLength(0);
    expect(doorbell.status()).toBe("unavailable");
  });

  test("last unsubscribe tears everything down; a late mint resolution no-ops", async () => {
    let release!: (m: MintResult) => void;
    const slowMint = new Promise<MintResult>((r) => (release = r));
    const h = { channels: [] as FakeChannel[], authed: [] as string[] };
    const doorbell = createDoorbell({
      mint: () => slowMint,
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
    });
    const off = doorbell.subscribe(() => {});
    off(); // teardown while the mint is still in flight
    release(MINT);
    await tick();
    expect(h.authed).toHaveLength(0);
    expect(h.channels).toHaveLength(0);
  });

  test("resubscribing after teardown starts a fresh doorbell", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT, ok({ token: "tok-2" })] });
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

describe("doorbell waking up", () => {
  test("a wake reconnects immediately instead of waiting out the backoff", async () => {
    // Same gap the room lane had: a backgrounded tab loses its socket, the drop
    // is reported honestly, and then live entity updates stay dead for up to a
    // minute of backoff on a page the user is looking at.
    const { h, doorbell } = makeHarness({ mints: [{ ok: false, reason: "unavailable" }] });
    const off = doorbell.subscribe(() => {});
    await tick();
    expect(doorbell.status()).toBe("unavailable");
    const before = h.mintCalls;

    // No timer is run: the reconnect must not depend on the retry rung.
    h.wake();
    await tick();
    expect(h.mintCalls).toBe(before + 1);
    off();
  });

  test("a wake while live does nothing", async () => {
    const { h, doorbell } = makeHarness({ mints: [MINT] });
    const off = doorbell.subscribe(() => {});
    await tick();
    h.channels[0]!.status!("SUBSCRIBED");
    expect(doorbell.status()).toBe("live");
    const before = h.mintCalls;
    h.wake();
    await tick();
    expect(h.mintCalls).toBe(before);
    off();
  });

  test("simultaneous wake signals coalesce into one reconnect", async () => {
    const { h, doorbell } = makeHarness({ mints: [{ ok: false, reason: "unavailable" }] });
    const off = doorbell.subscribe(() => {});
    await tick();
    const before = h.mintCalls;
    h.wake();
    h.wake();
    h.wake();
    await tick();
    expect(h.mintCalls).toBe(before + 1);
    off();
  });

  test("wake listeners are released with the last subscriber", async () => {
    const { h, doorbell } = makeHarness({ mints: [{ ok: false, reason: "unavailable" }] });
    expect(h.wakeSubs()).toBe(0);
    const a = doorbell.subscribe(() => {});
    const b = doorbell.subscribe(() => {});
    await tick();
    expect(h.wakeSubs()).toBe(1); // one shared doorbell, one subscription
    a();
    expect(h.wakeSubs()).toBe(1);
    b();
    expect(h.wakeSubs()).toBe(0);

    const before = h.mintCalls;
    h.wake();
    await tick();
    expect(h.mintCalls).toBe(before);
  });

  test("the last unsubscribe NOTIFIES the status reset, it does not just assign it", async () => {
    // A bare `state = "connecting"` leaves every onStatus subscriber holding
    // "live" for a doorbell that has been torn down — the same stale-snapshot
    // bug the room lane had, and invisible through status() alone.
    const seen: DoorbellStatus[] = [];
    const { h, doorbell } = makeHarness({ mints: [MINT], onStatus: (s) => seen.push(s) });
    const off = doorbell.subscribe(() => {});
    await tick();
    h.channels[0]!.status!("SUBSCRIBED");
    expect(doorbell.status()).toBe("live");
    seen.length = 0;
    off();
    expect(doorbell.status()).toBe("connecting");
    expect(seen).toEqual(["connecting"]); // the notification, not just the field
  });
});

describe("doorbell surviving supabase's synchronous CLOSED", () => {
  // Same production stack overflow as the room lane: removeChannel fires the
  // channel's status callback with CLOSED synchronously from inside leave(),
  // and the terminal-state handler responds by tearing down (which leaves).
  test("a real drop does not recurse, and the doorbell still retries", async () => {
    let mintCalls = 0;
    const joinCbs: Array<(s: string) => void> = [];
    const scheduled: Array<{ fn: () => void; cancelled: boolean }> = [];
    const doorbell = createDoorbell({
      async mint(): Promise<MintResult> {
        mintCalls++;
        return MINT;
      },
      setAuth: () => {},
      channel: () => {
        const me = joinCbs.length;
        return {
          onBroadcast: () => {},
          join(cb) {
            joinCbs[me] = cb;
          },
          leave() {
            joinCbs[me]?.("CLOSED"); // what removeChannel actually does
          },
        };
      },
      schedule: (fn) => {
        const t = { fn: fn as () => void, cancelled: false };
        scheduled.push(t);
        return t;
      },
      cancel: (h) => {
        (h as { cancelled: boolean }).cancelled = true;
      },
      wake: () => () => {},
    });
    const off = doorbell.subscribe(() => {});
    await tick();
    joinCbs[0]!("SUBSCRIBED");
    expect(doorbell.status()).toBe("live");

    joinCbs[0]!("CLOSED"); // pre-fix: RangeError, maximum call stack exceeded
    expect(doorbell.status()).toBe("unavailable");

    // recovery intact: the queued retry rung re-mints (cancelled timers,
    // like the orphaned refresh, must not)
    const before = mintCalls;
    for (const t of scheduled.splice(0)) if (!t.cancelled) t.fn();
    await tick();
    expect(mintCalls).toBe(before + 1);
    off();
  });
});
