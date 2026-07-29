/**
 * "The environment just came back" — the signal that a dropped realtime
 * connection should retry NOW instead of waiting out its backoff.
 *
 * Why this exists: the single most common realtime failure is also the most
 * mundane one. A backgrounded tab gets its timers throttled and its idle socket
 * dropped, so switching away and coming back finds the connection dead. The
 * drop itself IS reported (the channel reports a terminal state on return, which
 * lands in retry()), so recovery does happen — but on a [1s, 5s, 15s, 60s]
 * ladder it can take a full minute, and a minute of "offline" on a page the user
 * is actively looking at is indistinguishable from broken.
 *
 * Observed on a real deployed app: a tab left in the background reported OFFLINE
 * honestly and then took ~30s to come back. Every signal here resets the ladder
 * and reconnects immediately, which turns that into an unnoticeable blip.
 *
 * Both realtime machines (the entity doorbell and the room) subscribe to this;
 * neither had any wake handling before, and the gap was identical in both.
 */
export type WakeUnsubscribe = () => void;

/** Call `cb` whenever the tab/network wakes up. Returns unsubscribe.
 * A no-op (and safe) outside a DOM — server rendering, Node, tests. */
export function onWake(cb: () => void): WakeUnsubscribe {
  const offs: WakeUnsubscribe[] = [];

  const listen = (target: EventTarget | undefined, type: string, handler: () => void): void => {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, handler);
    offs.push(() => target.removeEventListener(type, handler));
  };

  const doc = typeof document === "undefined" ? undefined : document;
  const win = typeof window === "undefined" ? undefined : window;

  // Becoming visible is a wake; going hidden is not. Firing on hide would
  // reconnect a socket nobody is watching, only for it to be dropped again.
  listen(doc, "visibilitychange", () => {
    if (!doc || doc.visibilityState === "visible") cb();
  });
  // The network came back — the other way a connection dies without the page
  // ever being hidden.
  listen(win, "online", cb);
  // A desktop window that was never `hidden` (just covered by another app) can
  // still have had its socket time out. `focus` catches that case; it fires
  // alongside `visibilitychange`, which is why callers coalesce.
  listen(win, "focus", cb);

  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}
