// Retry a gateway request the platform rate-limited (HTTP 429).
//
// The Bool gateway answers 429 before it touches the app's database: the
// per-(app, visitor) limits in front of it reject the request outright. So a
// retry can't double-apply a write, and waiting it out is the right response.
// Without this, a burst (an import loop, a classroom refreshing at once) turned
// into silent failures that apps didn't handle.
//
// The wait honors the response's Retry-After (seconds), falls back to
// exponential backoff, adds jitter so a classroom of tabs doesn't retry in
// lockstep, and is capped so a page never hangs for long. After the last
// attempt the 429 response itself is returned, and the caller sees the error.

export type RetryOptions = {
  /** Retries after the first attempt. */
  retries?: number;
  /** Longest single wait, in ms. A Retry-After above this is clamped. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

const DEFAULTS = { retries: 3, maxWaitMs: 10_000 };

/** Retry-After as milliseconds: delta-seconds or an HTTP date. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Only bodies fetch can send twice. A ReadableStream is consumed by the first try. */
function isReplayable(body: BodyInit | null | undefined): boolean {
  return (
    body == null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof FormData !== "undefined" && body instanceof FormData)
  );
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchWithRateLimitRetry(
  doFetch: () => Promise<Response>,
  init: RequestInit | undefined,
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? DEFAULTS.retries;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULTS.maxWaitMs;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const canRetry = isReplayable(init?.body);

  for (let attempt = 0; ; attempt++) {
    const res = await doFetch();
    if (res.status !== 429 || !canRetry || attempt >= retries || init?.signal?.aborted) {
      return res;
    }
    const backoff = 500 * 2 ** attempt;
    const base = Math.min(retryAfterMs(res.headers.get("retry-after")) ?? backoff, maxWaitMs);
    // Up to 25% extra, so tabs that were limited together spread out.
    await sleep(base + base * 0.25 * random());
    // Free the connection: this response's body is never read.
    await res.body?.cancel().catch(() => {});
  }
}
