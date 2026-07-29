// The entity doorbell — change payloads for live entity views.
//
// A PURE CONSUMER of the shared RealtimeSession (session.ts): this module
// contains zero connection code. It declares which topics it wants (the app
// room, plus the personal user room when the wristband names a signed-in
// user), fans incoming change payloads out to every subscriber, and reports
// its delivery status. Mint, refresh, backoff, wake and teardown live in the
// session — written once, shared with bool.room.
//
// There is NO public channel and no fallback: every topic is wristband-gated,
// so a failure is reported and retried, never disguised as liveness. The old
// public compat channel cost 2× writes forever, leaked row ids on an
// anon-joinable topic, and spawned three follow-on bugs to serve nobody.
//
// Trust note: payloads on these topics are merged into entity state as
// server-trusted data. That is safe ONLY because the server's send policy
// makes the doorbell topics client-unwritable (clients may publish solely to
// the room topic family). Never weaken that policy; never join these topics
// with anything but `private: true`.

import type { BoolChangePayload } from "./client.js";
import type {
  ChannelGroup,
  RealtimeSession,
  RealtimeTopics,
  SessionChannel,
  SessionStatus,
} from "./session.js";

export type DoorbellStatus = SessionStatus;

/** One wristband, as the gateway mints it (/_bool/v1/realtime/token). */
export type RealtimeMint = {
  token: string;
  expiresIn: number;
  topics: RealtimeTopics;
};

export type MintResult =
  | { ok: true; mint: RealtimeMint }
  | { ok: false; reason: "unauthorized" | "unavailable" };

export type DoorbellDeps = {
  session: RealtimeSession;
  /** Create (not join) a private channel on `topic` with broadcast handlers
   * attachable. The session owns join/teardown. */
  makeChannel(topic: string): Pick<SessionChannel, "onBroadcast" | "join" | "leave">;
  /** Called whenever delivery state changes, so a client can surface it. */
  onStatus?: (status: DoorbellStatus) => void;
};

export type Doorbell = {
  /** Register a change listener. Starts delivery on the first listener, stops
   * after the last unsubscribes. Returns unsubscribe. */
  subscribe(listener: (payload: BoolChangePayload) => void): () => void;
  /** Current delivery state — for surfacing "not live" in a UI. */
  status(): DoorbellStatus;
};

/** Fill the SessionChannel members the doorbell never uses, so its adapter
 * stays as small as what it actually does: receive broadcasts. */
function asSessionChannel(
  ch: Pick<SessionChannel, "onBroadcast" | "join" | "leave">,
): SessionChannel {
  return {
    ...ch,
    track: (_s, done) => done?.("ok"),
    onPresence: () => {},
    send: (_e, _p, done) => done?.("ok"),
  };
}

export function createDoorbell(deps: DoorbellDeps): Doorbell {
  const listeners = new Set<(p: BoolChangePayload) => void>();
  const fanout = (p: BoolChangePayload) => {
    for (const l of listeners) l(p);
  };

  let state: DoorbellStatus = "connecting";

  const group: ChannelGroup = {
    // The app room, and the personal room when the mint carried a signed-in
    // user. Audiences are disjoint by construction (the trigger rings an owned
    // row's user room INSTEAD of the app room), so no dedupe is needed.
    topics: (t) => [t.app, t.user].filter((x): x is string => Boolean(x)),
    open(topic) {
      const ch = deps.makeChannel(topic);
      ch.onBroadcast((msg) => {
        fanout(((msg as { payload?: BoolChangePayload }).payload ?? {}) as BoolChangePayload);
      });
      return asSessionChannel(ch);
    },
    onStatus(s) {
      if (state === s) return;
      state = s;
      deps.onStatus?.(s);
    },
  };

  let unregister: (() => void) | null = null;

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) unregister = deps.session.register(group);
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) {
          unregister?.();
          unregister = null;
        }
      };
    },
    status: () => state,
  };
}
