// The private doorbell client — the SDK half of Bool's realtime design
// (platform: lib/bool-db.ts GATEWAY_GLOBAL_SETUP_SQL + the
// /_bool/v1/realtime/token plane).
//
// Live updates arrive as ROW-BEARING broadcasts on PRIVATE topics. Every topic
// is private: a socket holding no gateway-minted wristband hears nothing, and
// there is no public channel to fall back to. This module owns the lifecycle so
// app code (and useEntity) just gets payloads:
//   - mint the wristband from the gateway (which re-runs liveAccess/session on
//     every mint — that's where access is actually decided),
//   - setAuth + join the app room and, when signed in, the personal user room
//     (the trigger picks disjoint audiences, so the two never duplicate),
//   - re-mint at ~75% of the TTL so the socket never hits token expiry,
//   - on failure, RETRY with capped backoff and report status — never pretend.
//     A refused mint means the viewer isn't authorized (or the gateway is
//     unreachable); either way the honest outcome is "not live", surfaced, with
//     HTTP reads still working. Silently limping along on a degraded path is how
//     a broken realtime layer goes unnoticed for a week.
//   - share ONE doorbell across every subscriber (each entities.<table>
//     .subscribe used to open its own channel; now they ref-count this one).
//
// Everything effectful is injected (DoorbellDeps) so the machine is fully
// unit-testable without sockets.

import type { BoolChangePayload } from "./client.js";

/** What the wristband desk returns. Topic names are SERVER-authored so naming
 * lives in exactly one place. */
export type RealtimeMint = {
  token: string;
  /** Seconds until the token expires. */
  expiresIn: number;
  topics: {
    app: string;
    user: string | null;
    /** The ephemeral bool.room topic. Absent on platforms that predate it —
     * the room store then reports "unavailable" and retries. */
    room?: string | null;
  };
};

export type DoorbellChannel = {
  /** Register the broadcast payload handler (must be called before join). */
  onBroadcast(cb: (payload: BoolChangePayload) => void): void;
  /** Open the channel; `status` fires with supabase-style states. */
  join(status: (state: string) => void): void;
  leave(): void;
};

/** Why the doorbell isn't delivering, when it isn't.
 *  - `connecting` — first mint/join in flight
 *  - `live`       — joined; changes are arriving
 *  - `unauthorized` — the gateway refused a wristband (not authorized for this
 *    app, or end-user session expired). Retried, since access can be granted.
 *  - `unavailable` — gateway unreachable, realtime misconfigured, or the join
 *    was refused. Retried with backoff. */
export type DoorbellStatus = "connecting" | "live" | "unauthorized" | "unavailable";

/** Outcome of one mint attempt. The two failure kinds are distinguished on
 * purpose: "the gateway says no" and "I couldn't reach the gateway" mean very
 * different things to a viewer (and to whoever is debugging), and a public app
 * — where every visitor is normally admitted — must never be told it's
 * unauthorized because of a dropped request. */
export type MintResult =
  | { ok: true; mint: RealtimeMint }
  | { ok: false; reason: "unauthorized" | "unavailable" };

export type DoorbellDeps = {
  /** Mint one wristband. On failure report WHICH kind (see MintResult) — the
   * doorbell retries either way and never silently gives up. */
  mint(): Promise<MintResult>;
  /** Present the wristband to the realtime connection (supabase setAuth). */
  setAuth(token: string): Promise<void> | void;
  /** Create (not join) a private channel on `topic`. */
  channel(topic: string, opts: { private: boolean }): DoorbellChannel;
  /** Called whenever delivery state changes, so a client can surface it. */
  onStatus?: (status: DoorbellStatus) => void;
  /** Test seam; defaults to setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

// Re-mint at 75% of the TTL: early enough that a slow mint never races token
// expiry (which would close the channels underneath us), late enough that
// refresh traffic stays negligible.
const REFRESH_FRACTION = 0.75;
// A desk that answers with a nonsense TTL shouldn't melt into a mint loop.
const MIN_REFRESH_MS = 30_000;
// Retry backoff after a refused/failed mint or join: quick first, then capped so
// a long outage costs one request a minute rather than a hot loop.
const RETRY_MS = [1_000, 5_000, 15_000, 60_000];

export type Doorbell = {
  /** Register a change listener. Starts the machinery on the first listener,
   * tears it down after the last unsubscribes. Returns unsubscribe. */
  subscribe(listener: (payload: BoolChangePayload) => void): () => void;
  /** Current delivery state — for surfacing "not live" in a UI. */
  status(): DoorbellStatus;
};

export function createDoorbell(deps: DoorbellDeps): Doorbell {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const listeners = new Set<(p: BoolChangePayload) => void>();
  const fanout = (p: BoolChangePayload) => {
    for (const l of listeners) l(p);
  };

  // One "generation" per start(); every async continuation checks it so a
  // teardown (or a restart) orphans in-flight work instead of racing it.
  let gen = 0;
  let channels: DoorbellChannel[] = [];
  let timer: unknown = null;
  let attempt = 0;
  let state: DoorbellStatus = "connecting";

  function setStatus(next: DoorbellStatus): void {
    if (state === next) return;
    state = next;
    deps.onStatus?.(next);
  }

  function clearTimer(): void {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  function teardownChannels(): void {
    for (const ch of channels) ch.leave();
    channels = [];
    clearTimer();
  }

  /** Schedule the next attempt after a failure, with capped backoff. */
  function retry(myGen: number, why: DoorbellStatus): void {
    setStatus(why);
    const ms = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
    attempt++;
    timer = schedule(() => {
      if (myGen !== gen) return;
      void start(myGen);
    }, ms);
  }

  async function start(myGen: number): Promise<void> {
    teardownChannels();
    if (myGen !== gen) return;

    const res = await deps.mint();
    if (myGen !== gen) return;
    // No wristband: the app is NOT live. Report which kind of "no" it was and
    // try again — never fake liveness.
    if (!res.ok) return retry(myGen, res.reason);
    const m = res.mint;

    await deps.setAuth(m.token);
    if (myGen !== gen) return;

    // The app room, and the personal room when the mint carried a signed-in
    // user. Audiences are disjoint by construction (the trigger rings an owned
    // row's user room INSTEAD of the app room), so no dedupe is needed.
    let joined = 0;
    for (const topic of [m.topics.app, m.topics.user]) {
      if (!topic) continue;
      const ch = deps.channel(topic, { private: true });
      ch.onBroadcast(fanout);
      ch.join((s) => {
        if (myGen !== gen) return;
        if (s === "SUBSCRIBED") {
          joined++;
          attempt = 0; // a good join resets the backoff
          setStatus("live");
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
          // A refused private join means the wristband and the policy disagree
          // (misconfigured database, clock skew). Retry the whole handshake.
          teardownChannels();
          retry(myGen, "unavailable");
        }
      });
      channels.push(ch);
    }
    if (joined === 0 && channels.length === 0) return retry(myGen, "unavailable");

    scheduleRefresh(myGen, m.expiresIn);
  }

  function scheduleRefresh(myGen: number, expiresInSeconds: number): void {
    const ms = Math.max(expiresInSeconds * 1000 * REFRESH_FRACTION, MIN_REFRESH_MS);
    timer = schedule(async () => {
      if (myGen !== gen) return;
      const res = await deps.mint();
      if (myGen !== gen) return;
      // Renewal refused — access was revoked, or the gateway is down. The TTL
      // expiring is the whole revocation mechanism, so drop the rooms.
      if (!res.ok) {
        teardownChannels();
        return retry(myGen, res.reason);
      }
      await deps.setAuth(res.mint.token); // channels re-auth on the connection
      if (myGen !== gen) return;
      scheduleRefresh(myGen, res.mint.expiresIn);
    }, ms);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        gen++;
        attempt = 0;
        setStatus("connecting");
        void start(gen);
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) {
          gen++; // orphan any in-flight start/refresh
          teardownChannels();
          state = "connecting";
        }
      };
    },
    status: () => state,
  };
}
