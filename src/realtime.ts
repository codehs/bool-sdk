// The private doorbell client — the SDK half of Bool's "intercom + wristband"
// realtime design (platform: lib/bool-db.ts GATEWAY_GLOBAL_SETUP_SQL + the
// /_bool/v1/realtime/token plane).
//
// Live updates arrive as ROW-BEARING broadcasts on PRIVATE topics that only a
// gateway-minted token ("wristband") can join. This module owns the whole
// lifecycle so app code (and useEntity) just gets payloads:
//   - mint the wristband from the gateway (which re-runs liveAccess/session on
//     every mint — that's where access is actually decided),
//   - setAuth + join the app room and, when signed in, the personal user room
//     (the trigger picks disjoint audiences, so the two rooms never duplicate),
//   - re-mint at ~75% of the TTL so the socket never hits token expiry; a
//     failed re-mint (revoked access, gateway down) silences the private rooms
//     rather than erroring the app,
//   - fall back to the legacy PUBLIC row-data-free channel when the wristband
//     desk is unavailable (older platform, 503) so live-ness degrades to
//     ping+refetch instead of dying,
//   - share ONE doorbell across every subscriber (each entities.<table>
//     .subscribe used to open its own channel; now they ref-count this one).
//
// Everything effectful is injected (DoorbellDeps) so the machine is fully
// unit-testable without sockets — same dependency-injection discipline as the
// platform's plane handlers.

import type { BoolChangePayload } from "./client.js";

/** What the wristband desk returns. Topic names are SERVER-authored so naming
 * lives in exactly one repo. */
export type RealtimeMint = {
  token: string;
  /** Seconds until the token expires. */
  expiresIn: number;
  topics: { app: string; user: string | null };
};

export type DoorbellChannel = {
  /** Register the broadcast payload handler (must be called before join). */
  onBroadcast(cb: (payload: BoolChangePayload) => void): void;
  /** Open the channel; `status` fires with supabase-style states. */
  join(status: (state: string) => void): void;
  leave(): void;
};

export type DoorbellDeps = {
  /** Mint one wristband; null when the desk is unavailable (non-2xx, network,
   * or a pre-private-doorbell platform). */
  mint(): Promise<RealtimeMint | null>;
  /** Present the wristband to the realtime connection (supabase setAuth). */
  setAuth(token: string): Promise<void> | void;
  /** Create (not join) a channel on `topic`. */
  channel(topic: string, opts: { private: boolean }): DoorbellChannel;
  /** The legacy public topic (`bool:<schema>`) for the fallback path. */
  legacyTopic: string;
  /** Test seam; defaults to setTimeout/clearTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

// Re-mint at 75% of the TTL: early enough that a slow mint never races token
// expiry (which would close the channels underneath us), late enough that
// refresh traffic stays negligible.
const REFRESH_FRACTION = 0.75;
// A desk that answers but with a nonsense TTL shouldn't melt into a mint loop.
const MIN_REFRESH_MS = 30_000;

export type Doorbell = {
  /** Register a change listener. Starts the machinery on the first listener,
   * tears it down after the last unsubscribes. Returns unsubscribe. */
  subscribe(listener: (payload: BoolChangePayload) => void): () => void;
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
  let refreshHandle: unknown = null;

  function teardownChannels(): void {
    for (const ch of channels) ch.leave();
    channels = [];
    if (refreshHandle !== null) {
      cancel(refreshHandle);
      refreshHandle = null;
    }
  }

  function joinLegacy(myGen: number): void {
    if (myGen !== gen) return;
    const ch = deps.channel(deps.legacyTopic, { private: false });
    ch.onBroadcast(fanout);
    ch.join(() => {});
    channels.push(ch);
  }

  async function startPrivate(myGen: number): Promise<void> {
    const m = await deps.mint();
    if (myGen !== gen) return;
    if (!m) return joinLegacy(myGen);

    await deps.setAuth(m.token);
    if (myGen !== gen) return;

    // The app room, and the personal room when the mint carried a signed-in
    // user. Audiences are disjoint by construction (the trigger rings an
    // owned row's user room INSTEAD of the app room), so no dedupe is needed.
    for (const topic of [m.topics.app, m.topics.user]) {
      if (!topic) continue;
      const ch = deps.channel(topic, { private: true });
      ch.onBroadcast(fanout);
      ch.join((state) => {
        // A refused/failed private join (policy missing on an older database,
        // clock-skewed token) degrades to the public ping — worse latency,
        // never a dead app. Guard on gen so late errors after teardown no-op.
        if (state === "CHANNEL_ERROR" && myGen === gen) {
          teardownChannels();
          joinLegacy(myGen);
        }
      });
      channels.push(ch);
    }

    scheduleRefresh(myGen, m.expiresIn);
  }

  function scheduleRefresh(myGen: number, expiresInSeconds: number): void {
    const ms = Math.max(expiresInSeconds * 1000 * REFRESH_FRACTION, MIN_REFRESH_MS);
    refreshHandle = schedule(async () => {
      if (myGen !== gen) return;
      const m = await deps.mint();
      if (myGen !== gen) return;
      if (!m) {
        // Wristband renewal refused: access was revoked or the gateway is
        // unreachable. Go quiet on the private rooms (the whole point of the
        // TTL) and keep the app alive on the public ping.
        teardownChannels();
        return joinLegacy(myGen);
      }
      await deps.setAuth(m.token); // existing channels re-auth on the connection
      if (myGen !== gen) return;
      scheduleRefresh(myGen, m.expiresIn);
    }, ms);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        gen++;
        void startPrivate(gen);
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) {
          gen++; // orphan any in-flight start/refresh
          teardownChannels();
        }
      };
    },
  };
}
