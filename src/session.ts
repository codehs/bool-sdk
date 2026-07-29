// RealtimeSession — the ONE connection machine for everything realtime.
//
// Before this file existed, the entity doorbell (realtime.ts) and the room
// (room.ts) each carried their own copy of the connection lifecycle: mint a
// wristband, present it, open channels, refresh before the TTL, back off on
// failure, reconnect on wake, tear down without racing yourself. The copies
// drifted, and in one 24-hour stretch (2026-07-29) the two worst production
// bugs — the synchronous-CLOSED teardown recursion and the missing
// wake-reconnect — each had to be diagnosed and fixed TWICE, once per copy.
// This file is those fixes written once. The doorbell and every room are now
// pure consumers that register a ChannelGroup and contain zero connection code.
//
// Every guard below is a scar from a specific production failure. Deleting one
// re-earns it the hard way; the comment on each names the failure it prevents.

import { onWake } from "./wake.js";

export type SessionStatus = "connecting" | "live" | "unauthorized" | "unavailable";

/** The topics one wristband admits. `user` is null for anonymous visitors;
 * `room` is null on a platform that predates the room lane. */
export type RealtimeTopics = {
  app: string;
  user: string | null;
  room: string | null;
};

export type SessionMintResult =
  | { ok: true; token: string; expiresIn: number; topics: RealtimeTopics }
  | { ok: false; reason: "unauthorized" | "unavailable" };

/** The transport seam for one channel — everything effectful is injected so
 * the machine is unit-testable without sockets. Consumers create the channel
 * (they know their own presence/broadcast config); the session owns join,
 * teardown, and every status transition. */
export type SessionChannel = {
  track(state: Record<string, unknown>, done?: (result: string) => void): void;
  onPresence(cb: (states: Record<string, Array<Record<string, unknown>>>) => void): void;
  onBroadcast(cb: (msg: { event: string; payload: unknown }) => void): void;
  send(event: string, payload: unknown, done?: (result: string) => void): void;
  join(status: (state: string) => void): void;
  leave(): void;
};

/** One consumer's channels. The doorbell is one group (app + user topics);
 * every room — default or named — is its own group. Groups share the session's
 * single mint/auth/socket lifecycle. */
export type ChannelGroup = {
  /** Which topics this group wants under the current mint. Return [] when the
   * mint can't serve this group (e.g. no room topic on an old platform) — the
   * group is reported "unavailable" and re-asked on every reconnect/refresh,
   * so a platform deploy can turn it on without a reload. */
  topics(t: RealtimeTopics): string[];
  /** Create ONE channel for `topic` and attach message handlers. Do NOT join —
   * the session joins with its own guarded status callback. */
  open(topic: string): SessionChannel;
  /** One of this group's channels reached SUBSCRIBED (initial join or rejoin
   * after a drop). Re-publish anything a fresh channel must carry (the room's
   * membership beacon + current state live here). */
  onJoin?(ch: SessionChannel, topic: string): void;
  /** This group's channels are gone (teardown, restart, or unregister). */
  onDown?(): void;
  /** This GROUP's delivery status: the session's status, degraded to
   * "connecting" until every channel this group asked for has joined, and to
   * "unavailable" when the mint has no topic for it. */
  onStatus?(s: SessionStatus): void;
};

export type SessionDeps = {
  mint(): Promise<SessionMintResult>;
  setAuth(token: string): Promise<void> | void;
  onStatus?: (s: SessionStatus) => void;
  /** Test seams; default to timers/Date/DOM wake listeners. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
  wake?: (cb: () => void) => () => void;
};

export type RealtimeSession = {
  /** Add a group. Ref-counted: the first registration starts the machine, the
   * last unregister stops it. Registering mid-flight opens the group's
   * channels under the current mint immediately. Returns unregister. */
  register(group: ChannelGroup): () => void;
  status(): SessionStatus;
  onStatus(cb: (s: SessionStatus) => void): () => void;
};

// Backoff after a refused/failed mint or a dropped channel: quick first retry,
// capped so a long outage costs one request a minute rather than a hot loop.
const RETRY_MS = [1_000, 5_000, 15_000, 60_000];
// A mint that never settles would wedge the machine — no channel, no status
// change, no retry — indistinguishable from "live" to anything watching. Cap
// it and treat a stall as an ordinary "unavailable", which retries.
const MINT_TIMEOUT_MS = 10_000;
// Re-mint at 75% of the wristband TTL: early enough that a slow mint never
// races token expiry (which closes channels underneath us), late enough that
// refresh traffic stays negligible.
const REFRESH_FRACTION = 0.75;
// A desk that answers with a nonsense TTL must not melt into a mint loop.
const MIN_REFRESH_MS = 30_000;
// `focus` + `visibilitychange` fire together on tab re-selection, and `online`
// can pile on; one wake must be one reconnect, not three.
const WAKE_COALESCE_MS = 500;

type OpenChannel = { ch: SessionChannel; topic: string; joined: boolean };

export function createSession(deps: SessionDeps): RealtimeSession {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());
  const subscribeWake = deps.wake ?? onWake;

  // One "generation" per start(); every async continuation and every channel
  // status callback checks it, so a teardown or restart orphans in-flight work
  // instead of racing it.
  let gen = 0;
  let attempt = 0;
  let timer: unknown = null;
  let state: SessionStatus = "connecting";
  let topics: RealtimeTopics | null = null;

  const groups = new Set<ChannelGroup>();
  const open = new Map<ChannelGroup, OpenChannel[]>();

  const statusListeners = new Set<(s: SessionStatus) => void>();
  function setStatus(next: SessionStatus): void {
    if (state === next) return;
    // setStatus, never a bare assignment: a direct write leaves every
    // subscriber holding the stale value — the "torn-down but still says
    // live" bug, found independently in BOTH pre-session machines.
    state = next;
    deps.onStatus?.(next);
    for (const l of statusListeners) l(next);
    for (const g of groups) emitGroupStatus(g);
  }

  /** A group's status is the session's, degraded by its own facts: no topic in
   * the mint → unavailable; channels not all joined yet → connecting. */
  function groupStatus(g: ChannelGroup): SessionStatus {
    if (state !== "live") return state;
    const chans = open.get(g);
    if (!chans) return "connecting";
    if (chans.length === 0) return "unavailable"; // mint has no topic for it
    return chans.every((c) => c.joined) ? "live" : "connecting";
  }
  function emitGroupStatus(g: ChannelGroup): void {
    g.onStatus?.(groupStatus(g));
  }

  function clearTimer(): void {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  /** Close one group's channels. Detach BEFORE leaving: supabase's
   * removeChannel fires the channel's own status callback with CLOSED —
   * synchronously, from inside leave() — and the terminal-state handler tears
   * down in response. Leave-then-detach recursed teardown → leave → CLOSED →
   * teardown to a stack overflow on every real network drop (observed in
   * production as an endless "Maximum call stack size exceeded"). The
   * membership check in the join callback is the other half of this fix. */
  function closeGroup(g: ChannelGroup): void {
    const chans = open.get(g);
    if (!chans) return;
    open.delete(g);
    for (const c of chans) c.ch.leave();
    g.onDown?.();
  }

  function teardownAll(): void {
    for (const g of [...open.keys()]) closeGroup(g);
    clearTimer();
  }

  function retry(myGen: number, why: SessionStatus): void {
    setStatus(why);
    const ms = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
    attempt++;
    timer = schedule(() => {
      if (myGen !== gen) return;
      void start(myGen);
    }, ms);
  }

  /** Open one group's channels under the current mint and join them. Safe to
   * call for a group registered mid-flight. */
  function openGroup(g: ChannelGroup, myGen: number): void {
    if (!topics || open.has(g)) return;
    const wanted = g.topics(topics);
    const chans: OpenChannel[] = [];
    open.set(g, chans);
    for (const topic of wanted) {
      const ch = g.open(topic);
      const entry: OpenChannel = { ch, topic, joined: false };
      chans.push(entry);
      ch.join((s) => {
        // Membership, not just generation: closeGroup() empties the group's
        // entry and then leave() makes THIS callback fire CLOSED in the same
        // tick with the same gen. Without the check, that re-entered the
        // terminal branch and recursed to a stack overflow.
        if (myGen !== gen || open.get(g) !== chans) return;
        if (s === "SUBSCRIBED") {
          entry.joined = true;
          attempt = 0; // a good join resets the backoff ladder
          setStatus("live");
          emitGroupStatus(g);
          g.onJoin?.(ch, topic);
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          // Every terminal state must drive recovery: supabase-js does NOT
          // auto-rejoin, and leaving one unhandled (CLOSED, originally) meant
          // a dropped socket left delivery dead forever while the last
          // reported status stayed "live". One channel down restarts the
          // whole session: everything shares one socket and one token, so
          // partial restarts buy complexity, not resilience.
          teardownAll();
          retry(myGen, "unavailable");
        }
      });
    }
    emitGroupStatus(g);
  }

  async function start(myGen: number): Promise<void> {
    teardownAll();
    if (myGen !== gen) return;

    const res = await Promise.race([
      deps.mint(),
      new Promise<SessionMintResult>((resolve) =>
        schedule(() => resolve({ ok: false, reason: "unavailable" }), MINT_TIMEOUT_MS),
      ),
    ]);
    if (myGen !== gen) return;
    // No wristband: nothing is live. Report WHICH kind of "no" — a public app
    // where every visitor is normally admitted must never be told it's
    // unauthorized because of a dropped request — and retry. Never fake it.
    if (!res.ok) return retry(myGen, res.reason);

    await deps.setAuth(res.token);
    if (myGen !== gen) return;

    topics = res.topics;
    setStatus("live"); // mint-level; groups stay "connecting" until joined
    for (const g of groups) openGroup(g, myGen);
    scheduleRefresh(myGen, res.expiresIn);
  }

  function scheduleRefresh(myGen: number, expiresInSeconds: number): void {
    const ms = Math.max(expiresInSeconds * 1000 * REFRESH_FRACTION, MIN_REFRESH_MS);
    timer = schedule(async () => {
      if (myGen !== gen) return;
      const res = await deps.mint();
      if (myGen !== gen) return;
      // Renewal refused — access revoked, or the gateway is down. The TTL
      // expiring IS the revocation mechanism, so drop the channels.
      if (!res.ok) {
        teardownAll();
        return retry(myGen, res.reason);
      }
      await deps.setAuth(res.token); // channels re-auth in place, no rejoin
      if (myGen !== gen) return;
      topics = res.topics;
      scheduleRefresh(myGen, res.expiresIn);
    }, ms);
  }

  // ---- wake: come back the instant the tab/network does ---------------------
  // Browsers throttle background tabs and drop idle sockets; the drop is
  // reported honestly, but waiting out a [1s,5s,15s,60s] ladder after the
  // ordinary switch-tabs-and-return means up to a minute of "offline" on a
  // page the user is actively looking at — indistinguishable from broken.
  let stopWake: (() => void) | null = null;
  let lastWakeAt = -Infinity;
  function onWakeSignal(): void {
    // Already live: the socket is fine — reconnecting on every tab focus would
    // churn. A socket that is secretly dead reports its own terminal state,
    // which lands in retry(), which the next wake (or the 1s rung) picks up.
    if (groups.size === 0 || state === "live") return;
    const t = now();
    if (t - lastWakeAt < WAKE_COALESCE_MS) return;
    lastWakeAt = t;
    gen++; // orphan the pending retry and any in-flight start
    attempt = 0;
    setStatus("connecting");
    void start(gen);
  }

  return {
    register(group) {
      groups.add(group);
      if (groups.size === 1) {
        gen++;
        attempt = 0;
        setStatus("connecting");
        stopWake = subscribeWake(onWakeSignal);
        void start(gen);
      } else if (state === "live") {
        // Joined mid-flight (a second room opened): ride the current mint.
        openGroup(group, gen);
      } else {
        emitGroupStatus(group);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (!groups.delete(group)) return;
        closeGroup(group);
        if (groups.size === 0) {
          gen++; // orphan any in-flight start/refresh
          stopWake?.();
          stopWake = null;
          teardownAll();
          topics = null;
          setStatus("connecting");
        }
      };
    },
    status: () => state,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
  };
}
