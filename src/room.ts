// bool.room — the ephemeral lane. Live cursors, mid-stroke points, typing
// indicators, one-off reactions: data that flies browser-to-browser over the
// realtime socket and is NEVER stored. The durable lane (bool.entities) is for
// everything that must survive a reload; this is for everything that only
// matters while people are here together.
//
// This module is a PURE CONSUMER: it contains zero connection code. The
// mint/refresh/backoff/wake/teardown machinery lives in session.ts (shared
// with the entity doorbell), and this store registers one ChannelGroup per
// room. Before the split, this file carried its own copy of that machine and
// the copies drifted — see session.ts's header for the receipts.
//
// Design decisions that survived a week of production fires (full record:
// the platform's docs/2026-07-ephemeral-broadcast.md §9–§10):
//   - MEMBERSHIP rides Supabase presence (auto-clears on disconnect — no
//     hand-rolled heartbeats, no ghost cursors), but STATE rides broadcast.
//     Presence is a server-side CRDT built for low-frequency state and it
//     froze at 3 movers × 40Hz (track acks stopped inside a second); the
//     identical load over broadcast delivered 97–100% at ~10ms. So: one
//     `track({})` per join for who's-here, and `setMe` state flows as
//     throttled FULL-state broadcasts on the reserved `~me` event,
//     fire-and-forget — drops are healed by the next send.
//   - The throttle lives HERE, not in app code: a prompt rule asking the
//     model to throttle is forgettable; a setter that throttles isn't.
//   - Inbound coalesces to one emit per ~frame with STABLE peer identities —
//     otherwise every useOthers subscriber re-renders per message, and a
//     memoized cursor re-renders because someone else moved.
//   - Broadcast echoes to the SENDER locally and synchronously (never a round
//     trip): one code path for "everyone sees it, including me".
//   - Peer colors derive from peer ids (same hash on every client), so every
//     viewer agrees on everyone's color with nothing transmitted.
//   - Named rooms scope the topic (`bool:<schema>:room:<id>`); the default
//     room is the bare topic. Same wristband — the schema is the boundary.
//
// SECURITY: this module publishes ONLY to the dedicated room topic family
// (`bool:<schema>:room[:<id>]`), never to the doorbell topics. Doorbell
// messages are merged into entity state as trusted server data; the server's
// send policy is scoped so a client cannot publish there, and this module
// must never try.

import type { RealtimeSession, SessionChannel, SessionStatus } from "./session.js";

export type RoomStatus = SessionStatus;

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

// State sends coalesce on a trailing edge so the FINAL position always lands.
// 16ms ≈ 60/s — one send per frame, the ceiling a 60fps screen can show.
const TRACK_THROTTLE_MS = 16;
// The reserved broadcast event carrying a peer's full `setMe` state. App code
// cannot use "~"-prefixed event names (broadcast() rejects them), so this can
// never collide with a real event.
const ME_EVENT = "~me";
// When someone new joins, every peer re-sends its state once so the newcomer
// hydrates immediately instead of waiting for everyone's next move. Jittered
// so N peers don't stampede the channel in the same tick.
const HYDRATE_JITTER_MS = 300;
// Inbound coalescing: a room of movers can deliver hundreds of ~me messages a
// second; one emit per ~frame is all a screen can show anyway.
const EMIT_COALESCE_MS = 16;
// Realtime rejects large messages; failing loudly here names the actual
// problem instead of a silent server-side drop.
const MAX_PAYLOAD_BYTES = 60_000;

/** Per-message fan-out is O(peers), so the whole room's wire cost grows with
 * peers². Scale the send interval so a big room degrades to slower cursors
 * instead of a saturated channel. Budgeted against the raised tenant ceiling
 * on Bool's user-apps projects (10k events/s): full 60Hz through 10 people,
 * ~37Hz at 15, ~21Hz at 20. */
export function throttleForPeers(othersCount: number): number {
  const n = othersCount + 1;
  const budgetMs = Math.ceil((n * (n - 1)) / 8);
  return Math.max(TRACK_THROTTLE_MS, budgetMs);
}

/** Room ids become topic suffixes, so the charset is the policy's charset.
 * Loud rejection beats silent normalization: a normalized id would put two
 * "different" ids in one room. */
export const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
export function validateRoomId(id: string): string {
  if (!ROOM_ID_RE.test(id)) {
    throw new Error(
      `bool.room("${id}"): a room id is 1–64 characters of letters, digits, ` +
        `":", "_", ".", or "-" (starting with a letter or digit). ` +
        `Derive it from your own data — bool.room(\`game:\${gameId}\`).`,
    );
  }
  return id;
}

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
// string of emoji or CJK measures at roughly half to a third of what it
// actually sends. Measuring the encoded form is the only correct check.
function byteLength(s: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
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
  /** Ref-count the machinery: first acquire registers with the session, last
   * release unregisters. Every React hook acquires on mount. */
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

export type RoomStoreDeps = {
  session: RealtimeSession;
  /** null = the app-wide default room; a string scopes the topic. */
  roomId: string | null;
  /** Create (not join) the private room channel; `key` is this tab's presence
   * key. The session joins it with its own guarded status callback. */
  makeChannel(topic: string, key: string): SessionChannel;
  /** Test seams for the throttle/coalesce timers; default to timers. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
};

export function createRoomStore<P = Record<string, unknown>>(deps: RoomStoreDeps): RoomStore<P> {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());

  const self = { id: newTabId(), color: "" };
  self.color = colorForId(self.id);

  // ---- reactive bits --------------------------------------------------------
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
    for (const l of statusListeners) l(next);
  }

  const eventListeners = new Set<(event: string, e: RoomEvent) => void>();
  const dispatch = (event: string, e: RoomEvent) => {
    for (const l of eventListeners) l(event, e);
  };

  // ---- peers: membership (presence) ∪ state (~me broadcasts) ---------------
  // Membership is authoritative — state whose owner left is dropped, which is
  // what auto-clears a closed tab's cursor. Old-SDK peers still put state in
  // their presence meta, so meta is overlaid under ~me state for mixed rooms.
  let memberMeta = new Map<string, Record<string, unknown>>();
  const stateById = new Map<string, Record<string, unknown>>();

  // Stable peer identities: a peer whose inputs didn't change keeps the SAME
  // object between rebuilds, so a memoized <Cursor peer={o}/> for a still
  // person doesn't re-render because someone ELSE moved.
  const peerCache = new Map<
    string,
    { meta: Record<string, unknown>; state: Record<string, unknown> | undefined; peer: RoomPeer<P> }
  >();

  function rebuildOthers(): void {
    const next: Array<RoomPeer<P>> = [];
    for (const [id, meta] of memberMeta) {
      if (id === self.id) continue; // others NEVER includes you
      const peerState = stateById.get(id);
      const cached = peerCache.get(id);
      if (cached && cached.meta === meta && cached.state === peerState) {
        next.push(cached.peer);
        continue;
      }
      const presence = { ...meta, ...peerState };
      const peer: RoomPeer<P> = { id, color: colorForId(id), presence: presence as Partial<P> };
      peerCache.set(id, { meta, state: peerState, peer });
      next.push(peer);
    }
    for (const id of peerCache.keys()) {
      if (!memberMeta.has(id)) peerCache.delete(id);
    }
    next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    others = next;
    scheduleEmit();
  }

  // One emit per ~frame no matter how many messages landed inside it. The
  // FIRST change in a quiet period emits immediately (a reaction should not
  // wait 16ms); the flood behind it coalesces onto the trailing edge.
  let emitTimer: unknown = null;
  let lastEmitAt = -Infinity;
  function scheduleEmit(): void {
    const elapsed = now() - lastEmitAt;
    if (elapsed >= EMIT_COALESCE_MS) {
      lastEmitAt = now();
      emitOthers();
      return;
    }
    if (emitTimer !== null) return;
    emitTimer = schedule(() => {
      emitTimer = null;
      lastEmitAt = now();
      emitOthers();
    }, EMIT_COALESCE_MS - elapsed);
  }

  // ---- my state: merge + trailing-edge throttle, published over broadcast --
  const myState: Record<string, unknown> = {};
  let channel: SessionChannel | null = null;
  let joined = false;
  let trackTimer: unknown = null;
  let lastTrackAt = 0;

  /** Publish my full state now, fire-and-forget. Full state, not a delta:
   * drops are healed by the next send, and a late joiner needs one message,
   * not a replay. No ack — at cursor frequency, waiting on per-message acks
   * is what melted the presence transport. */
  function pushMe(): void {
    if (!channel || !joined) return;
    lastTrackAt = now();
    channel.send(ME_EVENT, { f: self.id, s: { ...myState } });
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

  function clearLocalTimers(): void {
    for (const t of [trackTimer, hydrateTimer, emitTimer]) if (t !== null) cancel(t);
    trackTimer = hydrateTimer = emitTimer = null;
  }

  // ---- the channel group (all connection logic lives in the session) -------
  const group = {
    topics(t: { room: string | null }): string[] {
      // A platform that predates the room lane has no room topic; returning []
      // makes the session report this group "unavailable" (retried on every
      // reconnect, so a platform deploy turns it on without a reload).
      if (!t.room) return [];
      return [deps.roomId === null ? t.room : `${t.room}:${deps.roomId}`];
    },
    open(topic: string): SessionChannel {
      const ch = deps.makeChannel(topic, self.id);
      ch.onPresence((states) => {
        const nextMeta = new Map<string, Record<string, unknown>>();
        let sawNewMember = false;
        for (const [key, metas] of Object.entries(states)) {
          // Supabase keeps one meta per connection under the key; last wins.
          const meta = metas[metas.length - 1] ?? {};
          const { presence_ref: _ref, ...rest } = meta as Record<string, unknown>;
          nextMeta.set(key, rest);
          if (key !== self.id && !memberMeta.has(key)) sawNewMember = true;
        }
        for (const id of stateById.keys()) {
          if (!nextMeta.has(id)) stateById.delete(id);
        }
        memberMeta = nextMeta;
        rebuildOthers();
        // Someone new arrived: re-send my state once (jittered) so they see
        // me now instead of on my next move.
        if (sawNewMember) scheduleHydrate();
      });
      ch.onBroadcast((msg) => {
        if (msg.event === ME_EVENT) {
          const env = (msg.payload ?? {}) as { f?: string; s?: Record<string, unknown> };
          if (!env.f || env.f === self.id) return;
          // State can outrun membership by a beat (broadcast delivers before
          // the presence diff); hold it either way — rebuildOthers keys off
          // membership, so it shows the moment the member appears.
          stateById.set(env.f, env.s ?? {});
          if (memberMeta.has(env.f)) rebuildOthers();
          return;
        }
        const env = (msg.payload ?? {}) as { f?: string; d?: unknown };
        if (env.f === self.id) return; // already delivered locally, synchronously
        dispatch(msg.event, { from: env.f ?? "", data: env.d });
      });
      channel = ch;
      return ch;
    },
    onJoin(): void {
      joined = true;
      // ONE membership beacon per join — presence carries who's-here, never
      // state. At one-per-join a failure can't melt into the reconnect storm
      // the per-move version caused; a genuinely dead channel reports its own
      // terminal state, which the session heals.
      channel?.track({}, (result) => {
        if (result !== "ok" && typeof console !== "undefined") {
          console.warn("bool.room: presence join beacon failed; peers may not see you until the next reconnect.");
        }
      });
      // Join/rejoin replays my current state so a reconnect (or a late first
      // join) never leaves me invisible.
      pushMe();
    },
    onDown(): void {
      channel = null;
      joined = false;
      clearLocalTimers();
      memberMeta = new Map();
      stateById.clear();
      peerCache.clear();
      if (others.length > 0) {
        others = [];
        // Direct, not coalesced: "the room emptied" must never be absorbed
        // into a cancelled trailing edge.
        emitOthers();
      }
    },
    onStatus(s: SessionStatus): void {
      setStatus(s);
    },
  };

  // ---- public surface --------------------------------------------------------
  let holds = 0;
  let unregister: (() => void) | null = null;

  return {
    self,
    acquire() {
      holds++;
      if (holds === 1) unregister = deps.session.register(group);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        if (holds === 0) {
          unregister?.();
          unregister = null;
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

/** The callable default room: `bool.room.useOthers()` is the app-wide room;
 * `bool.room("game:4")` is a scoped one with the identical surface. Same id →
 * same room instance (and one shared socket underneath them all). */
export type BoolRoomApi = BoolRoom & {
  (id: string): BoolRoom;
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

/** Build the callable `bool.room`: the default room's members on the function
 * itself, scoped rooms (memoized by id) on invocation. */
export function createBoolRoomApi(
  defaultRoom: BoolRoom,
  storeFor: (id: string) => RoomStore<Record<string, unknown>>,
): BoolRoomApi {
  const scoped = new Map<string, BoolRoom>();
  const fn = ((id: string): BoolRoom => {
    validateRoomId(id);
    let room = scoped.get(id);
    if (!room) {
      room = createBoolRoom(storeFor(id));
      scoped.set(id, room);
    }
    return room;
  }) as BoolRoomApi;
  fn.self = defaultRoom.self;
  fn.useOthers = defaultRoom.useOthers;
  fn.useSetMe = defaultRoom.useSetMe;
  fn.broadcast = defaultRoom.broadcast;
  fn.useEventListener = defaultRoom.useEventListener;
  fn.useStatus = defaultRoom.useStatus;
  return fn;
}
