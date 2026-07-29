import { describe, expect, test } from "bun:test";
import {
  createSession,
  type ChannelGroup,
  type SessionChannel,
  type SessionMintResult,
  type SessionStatus,
} from "./session";

// One test per scar. Each of these failures happened in production during the
// week the two pre-session machines existed; the session exists so each guard
// is written (and tested) exactly once.

const TOPICS = { app: "bool:app_x:app", user: "bool:app_x:user:u1", room: "bool:app_x:room" };

function makeHarness(opts?: {
  mints?: SessionMintResult[];
  /** leave() fires the join callback with CLOSED synchronously — what
   * supabase's removeChannel actually does (verified against the real client). */
  syncClosedOnLeave?: boolean;
}) {
  const mints = [...(opts?.mints ?? [])];
  let clock = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const wakeCbs = new Set<() => void>();
  const h = {
    mintCalls: 0,
    authed: [] as string[],
    channels: [] as Array<{
      topic: string;
      joinCb: ((s: string) => void) | null;
      left: boolean;
      sent: Array<{ event: string; payload: unknown }>;
    }>,
    statuses: [] as SessionStatus[],
    clockNow: () => clock,
    wake: () => {
      for (const cb of [...wakeCbs]) cb();
    },
    wakeSubs: () => wakeCbs.size,
    /** Run everything due within the next `ms` virtual milliseconds. */
    advance: async (ms: number) => {
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
    },
    live: () => h.channels.filter((c) => !c.left),
  };

  const session = createSession({
    async mint() {
      h.mintCalls++;
      return mints.length
        ? mints.shift()!
        : { ok: true, token: `tok-${h.mintCalls}`, expiresIn: 900, topics: TOPICS };
    },
    setAuth(token) {
      h.authed.push(token);
    },
    onStatus: (s) => h.statuses.push(s),
    schedule: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    cancel: (handle) => {
      const i = timers.findIndex((t) => t.id === handle);
      if (i !== -1) timers.splice(i, 1);
    },
    now: () => clock,
    wake: (cb) => {
      wakeCbs.add(cb);
      return () => wakeCbs.delete(cb);
    },
  });

  function makeGroup(
    topicsFor: (t: typeof TOPICS) => string[],
    hooks?: Partial<Pick<ChannelGroup, "onJoin" | "onDown" | "onStatus">>,
  ): ChannelGroup {
    return {
      topics: topicsFor as ChannelGroup["topics"],
      open(topic): SessionChannel {
        const rec = {
          topic,
          joinCb: null as ((s: string) => void) | null,
          left: false,
          sent: [] as Array<{ event: string; payload: unknown }>,
        };
        h.channels.push(rec);
        return {
          track: (_s, done) => done?.("ok"),
          onPresence: () => {},
          onBroadcast: () => {},
          send: (event, payload, done) => {
            rec.sent.push({ event, payload });
            done?.("ok");
          },
          join: (cb) => {
            rec.joinCb = cb;
          },
          leave: () => {
            rec.left = true;
            if (opts?.syncClosedOnLeave) rec.joinCb?.("CLOSED");
          },
        };
      },
      ...hooks,
    };
  }

  /** Drive every un-joined channel to SUBSCRIBED. */
  const joinAll = async () => {
    for (let i = 0; i < 50 && h.live().some((c) => !c.joinCb); i++) await Promise.resolve();
    for (const c of h.live()) c.joinCb?.("SUBSCRIBED");
    await Promise.resolve();
  };

  return { session, h, makeGroup, joinAll };
}

describe("session lifecycle", () => {
  test("mints once, auths, opens every group's channels, joins them", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness();
    const doorbell = makeGroup((t) => [t.app, t.user!]);
    const room = makeGroup((t) => [t.room!]);
    const off1 = session.register(doorbell);
    const off2 = session.register(room);
    await h.advance(0);
    await joinAll();
    expect(h.mintCalls).toBe(1); // ONE mint serves every consumer
    expect(h.authed).toEqual(["tok-1"]);
    expect(h.live().map((c) => c.topic)).toEqual([
      "bool:app_x:app",
      "bool:app_x:user:u1",
      "bool:app_x:room",
    ]);
    expect(session.status()).toBe("live");
    off1();
    off2();
  });

  test("a group registered mid-flight rides the current mint (no second handshake)", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness();
    const off1 = session.register(makeGroup((t) => [t.app]));
    await h.advance(0);
    await joinAll();
    const before = h.mintCalls;
    const off2 = session.register(makeGroup((t) => [`${t.room!}:board-2`]));
    await h.advance(0);
    expect(h.mintCalls).toBe(before); // opened a second named room for free
    expect(h.live().map((c) => c.topic)).toContain("bool:app_x:room:board-2");
    off1();
    off2();
  });

  test("a group whose topic the mint lacks reports unavailable, not a limp", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness({
      mints: [
        { ok: true, token: "t", expiresIn: 900, topics: { ...TOPICS, room: null } },
      ],
    });
    const seen: SessionStatus[] = [];
    const room = makeGroup((t) => (t.room ? [t.room] : []), { onStatus: (s) => seen.push(s) });
    const off = session.register(room);
    await h.advance(0);
    await joinAll();
    expect(seen.at(-1)).toBe("unavailable");
    off();
  });

  test("unregistering one group closes only its channels", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness();
    const off1 = session.register(makeGroup((t) => [t.app]));
    const off2 = session.register(makeGroup((t) => [t.room!]));
    await h.advance(0);
    await joinAll();
    off2();
    expect(h.live().map((c) => c.topic)).toEqual(["bool:app_x:app"]);
    expect(session.status()).toBe("live"); // the other consumer is untouched
    off1();
  });
});

describe("scar: synchronous CLOSED from inside leave()", () => {
  // supabase's removeChannel fires the channel's status callback with CLOSED
  // synchronously. The pre-session machines recursed teardown → leave → CLOSED
  // → teardown to a stack overflow on every real drop of a healthy channel.
  test("a real drop does not recurse, and the session still recovers", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness({ syncClosedOnLeave: true });
    const off = session.register(makeGroup((t) => [t.app]));
    await h.advance(0);
    await joinAll();
    expect(session.status()).toBe("live");

    h.live()[0]!.joinCb!("CLOSED"); // pre-fix: RangeError, max call stack
    expect(session.status()).toBe("unavailable");

    const channelsBefore = h.channels.length;
    await h.advance(1_000); // first retry rung
    expect(h.channels.length).toBe(channelsBefore + 1); // fresh channel opened
    await joinAll();
    expect(session.status()).toBe("live");
    off();
  });

  test("unregister with a live channel does not recurse either, and stays quiet", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness({ syncClosedOnLeave: true });
    const off = session.register(makeGroup((t) => [t.app]));
    await h.advance(0);
    await joinAll();
    off(); // teardown → leave → sync CLOSED, on the unmount path
    const before = h.channels.length;
    await h.advance(120_000);
    expect(h.channels.length).toBe(before); // nothing keeps retrying
  });
});

describe("scar: waking up", () => {
  test("a wake reconnects immediately instead of waiting out the backoff", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness();
    const off = session.register(makeGroup((t) => [t.app]));
    await h.advance(0);
    await joinAll();
    // drop, then keep dropping every fresh channel so the ladder climbs to
    // the 60s rung
    h.live()[0]!.joinCb!("CLOSED");
    for (let i = 0; i < 3; i++) {
      await h.advance(60_000); // the pending rung fires, a fresh channel opens
      const fresh = h.live()[0];
      fresh?.joinCb?.("CLOSED");
      await h.advance(0);
    }
    expect(session.status()).toBe("unavailable");
    const before = h.mintCalls;
    h.wake(); // no clock advance: must not be waiting on any timer
    await h.advance(0);
    expect(h.mintCalls).toBe(before + 1);
    await joinAll();
    expect(session.status()).toBe("live");
    off();
  });

  test("a wake while live does nothing, and simultaneous wakes coalesce", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness();
    const off = session.register(makeGroup((t) => [t.app]));
    await h.advance(0);
    await joinAll();
    const atLive = h.mintCalls;
    h.wake();
    await h.advance(0);
    expect(h.mintCalls).toBe(atLive); // no churn on tab focus

    h.live()[0]!.joinCb!("CLOSED");
    await h.advance(0);
    const beforeWakes = h.mintCalls;
    h.wake();
    h.wake();
    h.wake(); // focus + visibilitychange + online, same instant
    await h.advance(0);
    expect(h.mintCalls).toBe(beforeWakes + 1);
    off();
  });

  test("wake listeners are released with the last group (no zombie reconnects)", async () => {
    const { session, h, makeGroup } = makeHarness();
    expect(h.wakeSubs()).toBe(0);
    const off1 = session.register(makeGroup((t) => [t.app]));
    const off2 = session.register(makeGroup((t) => [t.room!]));
    expect(h.wakeSubs()).toBe(1); // one subscription for the whole session
    off1();
    expect(h.wakeSubs()).toBe(1);
    off2();
    expect(h.wakeSubs()).toBe(0);
    const before = h.mintCalls;
    h.wake();
    await h.advance(100);
    expect(h.mintCalls).toBe(before);
  });
});

describe("scar: the wristband desk", () => {
  test("a hung mint cannot wedge the session forever", async () => {
    const { session, h, makeGroup } = makeHarness({
      mints: [new Promise(() => {}) as never], // never settles
    });
    // a mint that never resolves isn't representable via the mints queue;
    // inject directly instead:
    const s2 = createSession({
      mint: () => new Promise(() => {}),
      setAuth: () => {},
      schedule: (fn, ms) => setTimeout(fn, ms / 1000), // compress time 1000×
      cancel: (h2) => clearTimeout(h2 as ReturnType<typeof setTimeout>),
      wake: () => () => {},
    });
    const off = s2.register(makeGroup((t) => [t.app]));
    await new Promise((r) => setTimeout(r, 25)); // > compressed MINT_TIMEOUT
    expect(s2.status()).toBe("unavailable");
    off();
    void session;
    void h;
  });

  test("refresh re-auths in place — channels do NOT rejoin", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness();
    const off = session.register(makeGroup((t) => [t.app]));
    await h.advance(0);
    await joinAll();
    const channelsBefore = h.channels.length;
    await h.advance(900 * 1000 * 0.75 + 1); // the refresh rung
    expect(h.authed).toEqual(["tok-1", "tok-2"]);
    expect(h.channels.length).toBe(channelsBefore); // same channels, new token
    expect(session.status()).toBe("live");
    off();
  });

  test("a refused re-mint drops every channel and reports unauthorized", async () => {
    // The TTL expiring IS the revocation mechanism: once the desk stops
    // issuing wristbands the socket must go quiet, not keep listening.
    const { session, h, makeGroup, joinAll } = makeHarness({
      mints: [
        { ok: true, token: "tok-1", expiresIn: 900, topics: TOPICS },
        { ok: false, reason: "unauthorized" },
      ],
    });
    const off = session.register(makeGroup((t) => [t.app, t.user!]));
    await h.advance(0);
    await joinAll();
    await h.advance(900 * 1000 * 0.75 + 1);
    expect(h.live()).toHaveLength(0);
    expect(session.status()).toBe("unauthorized");
    off();
  });

  test("an unreachable desk reports unavailable — NEVER unauthorized", async () => {
    // A public app admits every visitor; a dropped request must not be
    // presented as "you aren't allowed to watch this".
    const { session, h, makeGroup } = makeHarness({
      mints: [{ ok: false, reason: "unavailable" }],
    });
    const off = session.register(makeGroup((t) => [t.app]));
    await h.advance(0);
    expect(session.status()).toBe("unavailable");
    off();
  });

  test("the last unregister NOTIFIES the status reset (no stale live snapshot)", async () => {
    const { session, h, makeGroup, joinAll } = makeHarness();
    const off = session.register(makeGroup((t) => [t.app]));
    await h.advance(0);
    await joinAll();
    expect(session.status()).toBe("live");
    h.statuses.length = 0;
    off();
    expect(session.status()).toBe("connecting");
    expect(h.statuses).toEqual(["connecting"]); // the notification, not just the field
  });
});
