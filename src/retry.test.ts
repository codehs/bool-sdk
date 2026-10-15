import { describe, expect, test } from "bun:test";
import { fetchWithRateLimitRetry, retryAfterMs } from "./retry";

const limited = (retryAfter?: string) =>
  new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: retryAfter ? { "retry-after": retryAfter } : {},
  });
const ok = () => new Response("[]", { status: 200 });

function sequence(...responses: Array<() => Response>) {
  let i = 0;
  const calls = { count: 0 };
  const doFetch = async () => {
    calls.count++;
    return responses[Math.min(i++, responses.length - 1)]();
  };
  return { doFetch, calls };
}

function recordSleeps() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("fetchWithRateLimitRetry", () => {
  test("retries a 429 and returns the success", async () => {
    const { doFetch, calls } = sequence(() => limited("1"), ok);
    const { sleep } = recordSleeps();
    const res = await fetchWithRateLimitRetry(doFetch, { body: "{}" }, { sleep, random: () => 0 });
    expect(res.status).toBe(200);
    expect(calls.count).toBe(2);
  });

  test("waits the Retry-After the gateway sent", async () => {
    const { doFetch } = sequence(() => limited("2"), ok);
    const { waits, sleep } = recordSleeps();
    await fetchWithRateLimitRetry(doFetch, undefined, { sleep, random: () => 0 });
    expect(waits).toEqual([2000]);
  });

  test("backs off exponentially without a Retry-After", async () => {
    const { doFetch } = sequence(() => limited(), () => limited(), ok);
    const { waits, sleep } = recordSleeps();
    await fetchWithRateLimitRetry(doFetch, undefined, { sleep, random: () => 0 });
    expect(waits).toEqual([500, 1000]);
  });

  test("clamps a long Retry-After so a page never hangs", async () => {
    const { doFetch } = sequence(() => limited("3600"), ok);
    const { waits, sleep } = recordSleeps();
    await fetchWithRateLimitRetry(doFetch, undefined, { sleep, random: () => 0, maxWaitMs: 10_000 });
    expect(waits).toEqual([10_000]);
  });

  test("adds up to 25% jitter", async () => {
    const { doFetch } = sequence(() => limited("2"), ok);
    const { waits, sleep } = recordSleeps();
    await fetchWithRateLimitRetry(doFetch, undefined, { sleep, random: () => 1 });
    expect(waits).toEqual([2500]);
  });

  test("gives up after the retry budget and returns the 429", async () => {
    const { doFetch, calls } = sequence(() => limited("0"));
    const { sleep } = recordSleeps();
    const res = await fetchWithRateLimitRetry(doFetch, undefined, { sleep, retries: 3 });
    expect(res.status).toBe(429);
    expect(calls.count).toBe(4);
  });

  test("does not retry other failures", async () => {
    const { doFetch, calls } = sequence(() => new Response("{}", { status: 400 }), ok);
    const res = await fetchWithRateLimitRetry(doFetch, undefined, { sleep: async () => {} });
    expect(res.status).toBe(400);
    expect(calls.count).toBe(1);
  });

  test("does not retry a body that can only be sent once", async () => {
    const { doFetch, calls } = sequence(() => limited("0"), ok);
    const stream = new ReadableStream();
    const res = await fetchWithRateLimitRetry(doFetch, { body: stream }, { sleep: async () => {} });
    expect(res.status).toBe(429);
    expect(calls.count).toBe(1);
  });

  test("stops once the caller aborted", async () => {
    const { doFetch, calls } = sequence(() => limited("0"), ok);
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await fetchWithRateLimitRetry(doFetch, { signal: ctrl.signal }, { sleep: async () => {} });
    expect(res.status).toBe(429);
    expect(calls.count).toBe(1);
  });
});

describe("retryAfterMs", () => {
  test("reads delta-seconds", () => expect(retryAfterMs("3")).toBe(3000));
  test("reads an HTTP date", () =>
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000));
  test("ignores junk", () => expect(retryAfterMs("soon")).toBeNull());
  test("absent header is null", () => expect(retryAfterMs(null)).toBeNull());
});
