import { describe, expect, test } from "bun:test";
import { createDoorbell, type DoorbellStatus } from "./realtime";
import { createSession, type SessionMintResult } from "./session";
import type { BoolChangePayload } from "./client";

// The doorbell is a pure consumer: fan out payloads, pick topics, report
// status. Everything about the connection lifecycle (mint, refresh, backoff,
// wake, teardown, the sync-CLOSED scar) is the session's job and is tested
// once, in session.test.ts — not re-tested here.

const TOPICS = { app: "bool:app_x:app", user: "bool:app_x:user:u1", room: "bool:app_x:room" };

function makeHarness(opts?: { mints?: SessionMintResult[] }) {
  const mints = [...(opts?.mints ?? [])];
  const h = {
    mintCalls: 0,
    channels: [] as Array<{
      topic: string;
      joinCb: ((s: string) => void) | null;
      broadcastCb: ((msg: { event: string; payload: unknown }) => void) | null;
      left: boolean;
    }>,
    statuses: [] as DoorbellStatus[],
    live: () => h.channels.filter((c) => !c.left),
    ding(topic: string, payload: BoolChangePayload) {
      for (const ch of h.live()) {
        if (ch.topic === topic) ch.broadcastCb?.({ event: "change", payload });
      }
    },
    joinAll: async () => {
      for (let i = 0; i < 50 && h.live().some((c) => !c.joinCb); i++) await Promise.resolve();
      for (const c of h.live()) c.joinCb?.("SUBSCRIBED");
      await Promise.resolve();
    },
    tick: async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };

  const session = createSession({
    async mint() {
      h.mintCalls++;
      return mints.length
        ? mints.shift()!
        : { ok: true, token: `tok-${h.mintCalls}`, expiresIn: 900, topics: TOPICS };
    },
    setAuth: () => {},
    schedule: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    cancel: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    wake: () => () => {},
  });

  const doorbell = createDoorbell({
    session,
    makeChannel(topic) {
      const rec = {
        topic,
        joinCb: null as ((s: string) => void) | null,
        broadcastCb: null as ((msg: { event: string; payload: unknown }) => void) | null,
        left: false,
      };
      h.channels.push(rec);
      return {
        onBroadcast(cb) {
          rec.broadcastCb = cb;
        },
        join(cb) {
          rec.joinCb = cb;
        },
        leave() {
          rec.left = true;
        },
      };
    },
    onStatus: (s) => h.statuses.push(s),
  });

  return { h, doorbell, session };
}

describe("doorbell: topics and fan-out", () => {
  test("joins app + user rooms; payloads reach every listener via ONE doorbell", async () => {
    const { h, doorbell } = makeHarness();
    const a: BoolChangePayload[] = [];
    const b: BoolChangePayload[] = [];
    const offA = doorbell.subscribe((p) => a.push(p));
    const offB = doorbell.subscribe((p) => b.push(p));
    await h.tick();
    await h.joinAll();
    expect(h.mintCalls).toBe(1); // second subscriber reuses the running session
    expect(h.live().map((c) => c.topic)).toEqual(["bool:app_x:app", "bool:app_x:user:u1"]);

    h.ding("bool:app_x:app", { table: "todos", op: "INSERT", id: "1", row: { id: "1" } });
    h.ding("bool:app_x:user:u1", { table: "notes", op: "UPDATE", id: "2" });
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[0]!.row).toEqual({ id: "1" });
    offA();
    offB();
  });

  test("anonymous mint (no user topic) joins the app room only", async () => {
    const { h, doorbell } = makeHarness({
      mints: [{ ok: true, token: "t", expiresIn: 900, topics: { ...TOPICS, user: null } }],
    });
    const off = doorbell.subscribe(() => {});
    await h.tick();
    expect(h.live().map((c) => c.topic)).toEqual(["bool:app_x:app"]);
    off();
  });

  test("the last unsubscribe stops delivery; late payloads reach nobody", async () => {
    const { h, doorbell } = makeHarness();
    const got: BoolChangePayload[] = [];
    const off = doorbell.subscribe((p) => got.push(p));
    await h.tick();
    await h.joinAll();
    off();
    expect(h.live()).toHaveLength(0);
    h.ding("bool:app_x:app", { table: "todos", op: "INSERT", id: "9" });
    expect(got).toHaveLength(0);
  });
});

describe("doorbell: status is surfaced, never disguised", () => {
  test("a refused mint reports unauthorized and joins nothing", async () => {
    const { h, doorbell } = makeHarness({
      mints: [{ ok: false, reason: "unauthorized" }],
    });
    const off = doorbell.subscribe(() => {});
    await h.tick();
    expect(h.live()).toHaveLength(0);
    expect(doorbell.status()).toBe("unauthorized");
    off();
  });

  test("an unreachable gateway reports unavailable — NOT unauthorized", async () => {
    // A public app admits every visitor; a dropped request must never be
    // presented as "you aren't allowed to watch this".
    const { h, doorbell } = makeHarness({
      mints: [{ ok: false, reason: "unavailable" }],
    });
    const off = doorbell.subscribe(() => {});
    await h.tick();
    expect(doorbell.status()).toBe("unavailable");
    off();
  });

  test("status transitions flow through to the client hook", async () => {
    const { h, doorbell } = makeHarness();
    const off = doorbell.subscribe(() => {});
    await h.tick();
    await h.joinAll();
    expect(doorbell.status()).toBe("live");
    expect(h.statuses).toContain("live");
    off();
  });
});
