// bool.room — the ephemeral lane. Live cursors, mid-stroke points, typing
// indicators, one-off reactions: data that flies browser-to-browser over the
// realtime socket and is NEVER stored. The durable lane (bool.entities) is for
// everything that must survive a reload; this is for everything that only
// matters while people are here together.
//
// Design decisions (2026-07-29, from a three-way design review — see the
// platform's docs/2026-07-ephemeral-broadcast.md for the full record):
//   - Named `room`, not `live`: "live" already means the DURABLE lane
//     everywhere in this SDK (LiveEntityStore, "Live data" in the prompt), and
//     a name on both sides of the durable/ephemeral split is how data ends up
//     in the wrong lane. A room is who's here right now; nobody expects a room
//     to survive a reload.
//   - MEMBERSHIP rides Supabase presence (auto-clears on disconnect — no
//     hand-rolled heartbeats, no ghost cursors), but STATE rides broadcast.
//     Presence is a server-side CRDT built for low-frequency state, and it
//     falls over at cursor frequency: measured on real infra, 3 movers at 40Hz
//     had their `track()` calls stop being acknowledged within a second (5 acks
//     per mover, then 10s timeouts), while the identical 120 msg/s over
//     broadcast delivered 97–100% at ~10ms, sustained. Worse, treating those
//     timeouts as channel failure caused a reconnect storm — the UI flapped
//     between "N people here" and "live view unavailable". So: one `track({})`
//     per join for who's-here, and `setMe` state flows as throttled full-state
//     broadcasts on a reserved event, fire-and-forget. Full state (not deltas)
//     makes drops harmless — the next send heals everything.
//   - The throttle lives HERE, not in app code: a prompt rule asking the model
//     to throttle is forgettable; a setter that throttles isn't.
//   - Broadcast echoes to the SENDER locally and synchronously (never a round
//     trip): one code path for "everyone sees the reaction, including me",
//     with zero self-latency. The wire copy is filtered by sender id.
//   - Peer colors derive from peer ids (same hash on every client), so every
//     viewer agrees on everyone's color with nothing transmitted.
//
// SECURITY: this module publishes ONLY to the dedicated room topic
// (`bool:<schema>:room`), never to the doorbell topics. Doorbell messages are
// merged into entity state as trusted server data; the server's send policy is
// scoped so a client cannot publish there, and this module must never try.

import { onWake } from "./wake.js";

export type RoomStatus = "connecting" | "live" | "unauthorized" | "unavailable";

/** One other person in the room. `presence` is Partial on purpose: someone who
 * just joined has set nothing yet, so every field read must survive absence —
 * and under `strict` TS, the compiler enforces exactly that. */
export type RoomPeer<P = Record<string, unknown>> = {
  /** Stable per-tab id (not a user id — works in login-less apps). */
  id: string;
  /** Deterministic per-id color, identical on every viewer's screen. */
  color: string;
  presence: Partial<P>;
};

export type RoomEvent<T = unknown> = {
  /** Sender's per-tab id; `bool.room.self.id` for your own echoes. */
  from: string;
  data: T;
};

/** Result of one wristband mint (same desk the doorbell uses). */
export type RoomMintResult =
  | { ok: true; token: string; expiresIn: number; topic: string | null }
  | { ok: false; reason: "unauthorized" | "unavailable" };

/** The transport seam — everything effectful is injected so the machine and
 * store are unit-testable without sockets (same discipline as realtime.ts). */
export type RoomChannel = {
  /** Publish my full presence state (Supabase `track`). Reports the outcome:
   * supabase-js RESOLVES with the string "ok" | "timed out" | "error" rather
   * than throwing, so a `void`-ed call swallows every failure — which is how a
   * dead channel went unnoticed while the UI still said "live". */
  track(state: Record<string, unknown>, done?: (result: string) => void): void;
  /** Presence changed (sync/join/leave) — `states` is keyed by presence key. */
  onPresence(cb: (states: Record<string, Array<Record<string, unknown>>>) => void): void;
  /** Receive one broadcast envelope. */
  onBroadcast(cb: (msg: { event: string; payload: unknown }) => void): void;
  /** Send one broadcast envelope. Same outcome contract as `track`. */
  send(event: string, payload: unknown, done?: (result: string) => void): void;
  join(status: (state: string) => void): void;
  leave(): void;
};

export type RoomDeps = {
  mint(): Promise<RoomMintResult>;
  setAuth(token: string): Promise<void> | void;
  /** Create (not join) the private room channel; `key` is this tab's presence key. */
  channel(topic: string, key: string): RoomChannel;
  onStatus?: (status: RoomStatus) => void;
  /** Test seams; default to timers. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
  /** Subscribe to tab/network wake signals; defaults to the DOM listeners. */
  wake?: (cb: () => void) => () => void;
};

// State sends coalesce on a trailing edge so the FINAL position always lands.
// ~25ms ≈ 40/s, far above the ~24fps where motion reads as smooth.
const TRACK_THROTTLE_MS = 25;
// The reserved broadcast event carrying a peer's full `setMe` state. App code
// cannot use "~"-prefixed event names (broadcast() rejects them), so this can
// never collide with a real event.
const ME_EVENT = "~me";
// When someone new joins, every peer re-sends its state once so the newcomer
// hydrates immediately instead of waiting for everyone's next move. Jittered
// so N peers don't stampede the channel in the same tick.
const HYDRATE_JITTER_MS = 300;
/** Per-message fan-out is O(peers), so the whole room's wire cost grows with
 * peers². Scale the send interval so a big room degrades to slower cursors
 * instead of a saturated channel: full rate through ~6 people, ~n(n-1) ms
 * beyond (10 people → ~90ms ≈ 11Hz each). */
export function throttleForPeers(othersCount: number): number {
  const n = othersCount + 1;
  return Math.max(TRACK_THROTTLE_MS, n * (n - 1));
}
// Same shape/limits as the doorbell: quick first retry, capped so an outage
// costs one request a minute, refresh at 75% of the wristband TTL.
const RETRY_MS = [1_000, 5_000, 15_000, 60_000];
// A mint that never settles would wedge the machine: no channel, no status
// change, no retry — indistinguishable from "live" to anything watching. Cap it
// and treat a stall as an ordinary unavailable, which retries.
const MINT_TIMEOUT_MS = 10_000;
const REFRESH_FRACTION = 0.75;
const MIN_REFRESH_MS = 30_000;
// Realtime rejects large messages; failing loudly here names the actual
// problem instead of a silent server-side drop.
const MAX_PAYLOAD_BYTES = 60_000;
// `focus` and `visibilitychange` fire together when a tab is re-selected, and
// `online` can pile on. Without a window, one wake would restart the handshake
// two or three times.
const WAKE_COALESCE_MS = 500;

// 12 distinguishable hues; index by a stable hash of the peer id so every
// client computes the same color for the same peer.
const HUES = [4, 32, 56, 96, 152, 176, 200, 224, 256, 284, 312, 340];
function hashOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h;
}
export function colorForId(id: string): string {
  return `hsl(${HUES[Math.abs(hashOf(id)) % HUES.length]} 85% 55%)`;
}

// The wire limit is BYTES, and `String.length` counts UTF-16 code units — so a
// string of emoji or CJK measures at roughly half to a third of what it actually
// sends. Measuring the encoded form is the only correct check; the previous
// `.length` version would wave through a payload well over the limit and let the
// server drop it silently, which is the exact failure the guard exists to name.
function byteLength(s: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  // Old/exotic runtime: count UTF-8 bytes directly rather than lie.
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function newTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `tab-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export type RoomStore<P = Record<string, unknown>> = {
  self: { id: string; color: string };
  /** Ref-count the machinery: first acquire connects, last release tears down.
   * Every React hook acquires on mount. */
  acquire(): () => void;
  status(): RoomStatus;
  onStatus(cb: (s: RoomStatus) => void): () => void;
  /** Everyone else, newest snapshot. Stable identity when nothing changed. */
  getOthers(): ReadonlyArray<RoomPeer<P>>;
  onOthers(cb: () => void): () => void;
  /** Shallow-merge into my presence; throttled; `undefined` deletes a key. */
  setMe(patch: Record<string, unknown>): void;
  /** Remove specific keys (a hook clears its own keys on unmount). */
  clearMe(keys: string[]): void;
  broadcast(event: string, data: unknown): void;
  onEvent(cb: (event: string, e: RoomEvent) => void): () => void;
};

export function createRoomStore<P = Record<string, unknown>>(deps: RoomDeps): RoomStore<P> {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const self = { id: newTabId(), color: "" };
  self.color = colorForId(self.id);

  // ---- reactive bits -------------------------------------------------------
  let others: ReadonlyArray<RoomPeer<P>> = [];
  const othersListeners = new Set<() => void>();
  const emitOthers = () => {
    for (const l of othersListeners) l();
  };

  let state: RoomStatus = "connecting";
  const statusListeners = new Set<(s: RoomStatus) => void>();
  function setStatus(next: RoomStatus): void {
    if (state === next) return;
    state = next;
    deps.onStatus?.(next);
    for (const l of statusListeners) l(next);
  }

  const eventListeners = new Set<(event: string, e: RoomEvent) => void>();
  const dispatch = (event: string, e: RoomEvent) => {
    for (const l of eventListeners) l(event, e);
  };

  // ---- my state: merge + trailing-edge throttle, published over broadcast --
  const myState: Record<string, unknown> = {};
  let trackTimer: unknown = null;
  let lastTrackAt = 0;
  const now = deps.now ?? (() => Date.now());
  const subscribeWake = deps.wake ?? onWake;

  // Peer state assembled from two lanes: presence gives MEMBERSHIP (who's
  // connected, auto-cleared on disconnect) plus any state old-SDK peers still
  // put in their presence meta; ~me broadcasts give current-SDK peers' state.
  // A peer's visible presence = meta overlaid with its last ~me. Both maps are
  // keyed by peer id; membership is authoritative — state without membership
  // is dropped (its owner disconnected).
  let memberMeta = new Map<string, Record<string, unknown>>();
  const stateById = new Map<string, Record<string, unknown>>();

  function rebuildOthers(): void {
    const next: Array<RoomPeer<P>> = [];
    for (const [id, meta] of memberMeta) {
      if (id === self.id) continue; // others NEVER includes you
      const presence = { ...meta, ...stateById.get(id) };
      next.push({ id, color: colorForId(id), presence: presence as Partial<P> });
    }
    next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    others = next;
    emitOthers();
  }

  /** Publish my full state now, fire-and-forget. Full state, not a delta:
   * drops are healed by the next send, and a late joiner needs one message,
   * not a replay. No ack — at cursor frequency, waiting on per-message acks is
   * what melted the presence transport. */
  function pushMe(): void {
    if (!channel || !joined) return;
    lastTrackAt = now();
    channel.send(ME_EVENT, { f: self.id, s: { ...myState } });
  }

  /** A live channel turned out not to be live. Tear it down and reconnect with
   * backoff, reporting the honest status on the way. Guarded so several
   * failures in one generation collapse into one restart. */
  function unhealthy(why: string): void {
    if (holds === 0) return; // nobody is watching; acquire() will start fresh
    if (typeof console !== "undefined") {
      console.warn(`bool.room: reconnecting (${why}).`);
    }
    gen++;
    const myGen = gen;
    teardown();
    retry(myGen, "unavailable");
  }
  function scheduleMe(): void {
    if (!channel || !joined) return; // replayed on join instead
    const throttle = throttleForPeers(others.length);
    const elapsed = now() - lastTrackAt;
    if (elapsed >= throttle) return pushMe();
    if (trackTimer !== null) return; // trailing edge already armed
    trackTimer = schedule(() => {
      trackTimer = null;
      pushMe();
    }, throttle - elapsed);
  }

  // One pending hydration re-send, jittered off the peer-id hash so N peers
  // answering the same join don't stampede the channel in one tick.
  let hydrateTimer: unknown = null;
  function scheduleHydrate(): void {
    if (hydrateTimer !== null) return;
    if (Object.keys(myState).length === 0) return; // nothing to tell them
    const jitter = 1 + (Math.abs(hashOf(self.id)) % HYDRATE_JITTER_MS);
    hydrateTimer = schedule(() => {
      hydrateTimer = null;
      pushMe();
    }, jitter);
  }

  // ---- connection machine (gen/backoff/refresh, doorbell-style) ------------
  let holds = 0;
  let gen = 0;
  let channel: RoomChannel | null = null;
  let joined = false;
  let timer: unknown = null;
  let attempt = 0;

  function clearTimer(): void {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }
  function teardown(): void {
    // Null the reference BEFORE leaving. supabase's removeChannel fires the
    // channel's own status callback with CLOSED — synchronously, from inside
    // leave() — and the terminal-state handler tears down in response. With the
    // old order (leave first, null after) that re-entered here while `channel`
    // still pointed at the same channel: leave → CLOSED → teardown → leave → …
    // a stack overflow on every real network drop. The handler's
    // channel-identity guard is the other half of this fix.
    const ch = channel;
    channel = null;
    joined = false;
    ch?.leave();
    clearTimer();
    if (trackTimer !== null) {
      cancel(trackTimer);
      trackTimer = null;
    }
    if (hydrateTimer !== null) {
      cancel(hydrateTimer);
      hydrateTimer = null;
    }
    memberMeta = new Map();
    stateById.clear();
    if (others.length > 0) {
      others = [];
      emitOthers();
    }
  }
  function retry(myGen: number, why: RoomStatus): void {
    setStatus(why);
    const ms = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
    attempt++;
    timer = schedule(() => {
      if (myGen !== gen) return;
      void start(myGen);
    }, ms);
  }

  // ---- wake: come back the instant the tab/network does --------------------
  // Waiting out the backoff after the ordinary switch-tabs-and-return case is
  // what makes a working room look broken (see wake.ts). A wake resets the
  // ladder and reconnects now.
  let stopWake: (() => void) | null = null;
  let lastWakeAt = -Infinity;
  function onWakeSignal(): void {
    // Nothing mounted: no connection to restore. Already live: the socket is
    // fine, and one that is secretly dead reports its own close on wake and
    // lands in retry() — which the NEXT wake signal, or the 1s first rung,
    // picks up. Reconnecting a live room on every tab focus would churn.
    if (holds === 0 || state === "live") return;
    const t = now();
    if (t - lastWakeAt < WAKE_COALESCE_MS) return;
    lastWakeAt = t;
    gen++; // orphan the pending retry and any in-flight start
    attempt = 0;
    setStatus("connecting");
    void start(gen);
  }

  async function start(myGen: number): Promise<void> {
    teardown();
    if (myGen !== gen) return;

    const res = await Promise.race([
      deps.mint(),
      new Promise<RoomMintResult>((resolve) =>
        schedule(() => resolve({ ok: false, reason: "unavailable" }), MINT_TIMEOUT_MS),
      ),
    ]);
    if (myGen !== gen) return;
    if (!res.ok) return retry(myGen, res.reason);
    // A platform that predates the room topic can't host one — honest
    // unavailability (retried: a deploy can turn it on) rather than a limp.
    if (!res.topic) return retry(myGen, "unavailable");

    await deps.setAuth(res.token);
    if (myGen !== gen) return;

    const ch = deps.channel(res.topic, self.id);
    ch.onPresence((states) => {
      if (myGen !== gen) return;
      const nextMeta = new Map<string, Record<string, unknown>>();
      let sawNewMember = false;
      for (const [key, metas] of Object.entries(states)) {
        // Supabase keeps one meta per connection under the key; last wins.
        const meta = metas[metas.length - 1] ?? {};
        const { presence_ref: _ref, ...rest } = meta as Record<string, unknown>;
        nextMeta.set(key, rest);
        if (key !== self.id && !memberMeta.has(key)) sawNewMember = true;
      }
      // Membership is authoritative: state whose owner left is dropped, which
      // is what auto-clears a closed tab's cursor.
      for (const id of stateById.keys()) {
        if (!nextMeta.has(id)) stateById.delete(id);
      }
      memberMeta = nextMeta;
      rebuildOthers();
      // Someone new arrived: re-send my state once (jittered) so they see me
      // now instead of on my next move.
      if (sawNewMember) scheduleHydrate();
    });
    ch.onBroadcast((msg) => {
      if (myGen !== gen) return;
      if (msg.event === ME_EVENT) {
        const env = (msg.payload ?? {}) as { f?: string; s?: Record<string, unknown> };
        if (!env.f || env.f === self.id) return;
        // State can outrun membership by a beat (broadcast delivers before the
        // presence diff); hold it either way — rebuildOthers keys off
        // membership, so it shows the moment the member appears.
        stateById.set(env.f, env.s ?? {});
        if (memberMeta.has(env.f)) rebuildOthers();
        return;
      }
      const env = (msg.payload ?? {}) as { f?: string; d?: unknown };
      if (env.f === self.id) return; // already delivered locally, synchronously
      dispatch(msg.event, { from: env.f ?? "", data: env.d });
    });
    // Current BEFORE join() is registered: the status callback guards on
    // channel identity, and a callback that fired before the assignment would
    // wrongly see itself as stale.
    channel = ch;
    ch.join((s) => {
      // The identity check (not just gen) is load-bearing: teardown() nulls
      // `channel` and then leave() makes THIS callback fire CLOSED, same tick,
      // same gen. Without the check that re-entered the terminal branch below
      // and recursed teardown → leave → CLOSED → teardown to a stack overflow
      // on every real network drop.
      if (myGen !== gen || channel !== ch) return;
      if (s === "SUBSCRIBED") {
        joined = true;
        attempt = 0;
        setStatus("live");
        // ONE membership beacon per join — presence carries who's-here, never
        // state (see the transport note at the top of this file). This is the
        // only track() the store ever issues, so its failure genuinely means
        // the channel is broken and healing is right; at one-per-join it can
        // never melt into the reconnect storm the per-move version caused.
        ch.track({}, (result) => {
          if (result !== "ok" && myGen === gen) unhealthy("presence join failed");
        });
        // Join/rejoin replays my current state so a reconnect (or a late
        // first join) never leaves me invisible.
        pushMe();
      } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
        // CLOSED was previously unhandled, which meant a socket that dropped
        // (network blip, server close, token expiry, a StrictMode teardown
        // racing a re-subscribe) left the room permanently dead while the last
        // reported status stayed "live". supabase-js does NOT auto-rejoin, so
        // every terminal state must drive recovery. Verified against a real
        // close: the status arrives as CHANNEL_ERROR "socket closed: 1005"
        // with no follow-up SUBSCRIBED.
        joined = false;
        teardown();
        retry(myGen, "unavailable");
      }
    });
    scheduleRefresh(myGen, res.expiresIn);
  }

  function scheduleRefresh(myGen: number, expiresInSeconds: number): void {
    const ms = Math.max(expiresInSeconds * 1000 * REFRESH_FRACTION, MIN_REFRESH_MS);
    const prev = timer;
    timer = schedule(async () => {
      if (myGen !== gen) return;
      const res = await deps.mint();
      if (myGen !== gen) return;
      if (!res.ok) return retry(myGen, res.reason);
      await deps.setAuth(res.token);
      if (myGen !== gen) return;
      scheduleRefresh(myGen, res.expiresIn);
    }, ms);
    if (prev !== null && prev !== timer) cancel(prev);
  }

  return {
    self,
    acquire() {
      holds++;
      if (holds === 1) {
        gen++;
        attempt = 0;
        setStatus("connecting");
        stopWake = subscribeWake(onWakeSignal);
        void start(gen);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        if (holds === 0) {
          gen++;
          stopWake?.();
          stopWake = null;
          teardown();
          // setStatus, never a bare assignment: a direct write leaves every
          // useSyncExternalStore subscriber holding a stale snapshot, which is
          // exactly how a torn-down room kept rendering "live" forever.
          setStatus("connecting");
        }
      };
    },
    status: () => state,
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    getOthers: () => others,
    onOthers(cb) {
      othersListeners.add(cb);
      return () => othersListeners.delete(cb);
    },
    setMe(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete myState[k];
        else myState[k] = v;
      }
      scheduleMe();
    },
    clearMe(keys) {
      let changed = false;
      for (const k of keys) {
        if (k in myState) {
          delete myState[k];
          changed = true;
        }
      }
      if (changed) scheduleMe();
    },
    broadcast(event, data) {
      if (event.startsWith("~")) {
        // "~" names the SDK's own wire events (~me carries setMe state). A
        // user event on that namespace would be read back as peer state.
        throw new Error(
          `bool.room.broadcast("${event}"): event names starting with "~" are reserved for the SDK. Pick another name.`,
        );
      }
      const envelope = { f: self.id, d: data };
      const size = byteLength(JSON.stringify(envelope) ?? "");
      if (size > MAX_PAYLOAD_BYTES) {
        throw new Error(
          `bool.room.broadcast("${event}") payload is ${size} bytes — over the ${MAX_PAYLOAD_BYTES}-byte realtime limit. ` +
            `Send a reference (an id) instead of the thing itself, or save the thing via bool.entities.`,
        );
      }
      // Local echo FIRST, synchronously: your own reaction never waits for the
      // network, and a one-tab app behaves identically to a ten-tab one.
      dispatch(event, { from: self.id, data });
      channel?.send(event, envelope);
    },
    onEvent(cb) {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
  };
}

// ---------------------------------------------------------------------------
// Public surface + React registration.
//
// Core stays React-free (this module never imports React). The hooks below
// delegate to an implementation that importing "bool-sdk/react" registers —
// the same pattern, and the same hard-won lesson, as entities' useQuery: the
// react entry is loaded via a USED BINDING in the seeded client file, because
// a bare side-effect import binds no names and bundlers delete it from
// production builds (that shipped once, as 0.3.0, and broke every published
// app while previews looked fine).
//
// Deliberately NO string index signature on BoolRoom: a hallucinated member
// (`useStorage`, `useMyPresence`, `RoomProvider`…) must be a build error, not
// an `undefined is not a function` in front of a user.

export type BoolRoom = {
  /** This tab's identity: a per-tab id (not a user id — login-less apps have
   * cursors too) and the color every OTHER viewer will show for you. */
  self: { id: string; color: string };
  /** React hook: everyone else in the room, live. Hydrated on join,
   * auto-cleared when someone disconnects, `[]` until connected. Peers only —
   * never you. */
  useOthers<P = Record<string, unknown>>(): ReadonlyArray<RoomPeer<P>>;
  /** React hook returning the presence setter. Shallow-merges, throttled
   * inside the SDK (never throttle it yourself), and the keys this component
   * set are cleared when it unmounts — so a cursor never outlives its screen.
   * Call it straight from the raw event handler; putting pointer positions in
   * React state re-renders per mousemove. */
  useSetMe<P = Record<string, unknown>>(): (patch: Partial<P>) => void;
  /** One-shot to everyone in the room — including this tab, synchronously, so
   * your own reaction never waits for the network. Fire-and-forget: returns
   * void, delivery is best-effort, nothing is stored. */
  broadcast(event: string, data: unknown): void;
  /** React hook: receive one named event. Subscription lifecycle, StrictMode
   * safety and latest-callback semantics are handled inside. */
  useEventListener<T = unknown>(event: string, cb: (e: RoomEvent<T>) => void): void;
  /** React hook: honest delivery state. `[]` others + `"unavailable"` means
   * "can't know who's here", not "alone" — say so instead of guessing. */
  useStatus(): RoomStatus;
};

type RoomHooksImpl = {
  useOthers(store: RoomStore<Record<string, unknown>>): ReadonlyArray<RoomPeer<Record<string, unknown>>>;
  useSetMe(store: RoomStore<Record<string, unknown>>): (patch: Record<string, unknown>) => void;
  useEventListener(
    store: RoomStore<Record<string, unknown>>,
    event: string,
    cb: (e: RoomEvent) => void,
  ): void;
  useStatus(store: RoomStore<Record<string, unknown>>): RoomStatus;
};

let roomHooksImpl: RoomHooksImpl | null = null;
/** Registered by "bool-sdk/react" at import time. Returns the previous impl so
 * tests can restore it (module state is process-global under bun test). */
export function __registerRoomHooks(impl: RoomHooksImpl | null): RoomHooksImpl | null {
  const prev = roomHooksImpl;
  roomHooksImpl = impl;
  return prev;
}

function requireHooks(member: string): RoomHooksImpl {
  if (!roomHooksImpl) {
    throw new Error(
      `bool.room.${member}() needs the React entry loaded once per app — ` +
        `add \`import { createBoolClient } from "bool-sdk/react";\` (Bool apps already create ` +
        `their client from that entry in src/lib/supabase.ts). Outside React, bool.room has no surface yet.`,
    );
  }
  return roomHooksImpl;
}

let warnedUnmountedBroadcast = false;

/** Bind one store to the public `bool.room` shape. */
export function createBoolRoom(store: RoomStore<Record<string, unknown>>): BoolRoom {
  return {
    self: store.self,
    useOthers<P = Record<string, unknown>>() {
      return requireHooks("useOthers").useOthers(store) as ReadonlyArray<RoomPeer<P>>;
    },
    useSetMe<P = Record<string, unknown>>() {
      return requireHooks("useSetMe").useSetMe(store) as (patch: Partial<P>) => void;
    },
    broadcast(event, data) {
      if (store.status() !== "live" && !warnedUnmountedBroadcast) {
        warnedUnmountedBroadcast = true;
        console.warn(
          `bool.room.broadcast("${event}"): the room isn't connected yet, so only this tab saw it. ` +
            `The room connects while a bool.room hook is mounted (useOthers / useEventListener / useStatus).`,
        );
      }
      store.broadcast(event, data);
    },
    useEventListener<T = unknown>(event: string, cb: (e: RoomEvent<T>) => void) {
      requireHooks("useEventListener").useEventListener(store, event, cb as (e: RoomEvent) => void);
    },
    useStatus() {
      return requireHooks("useStatus").useStatus(store);
    },
  };
}
