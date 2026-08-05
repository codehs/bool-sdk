import { beforeEach, describe, expect, test } from "bun:test";
import {
  createBoolClient,
  getDefaultBoolClient,
  hasDefaultBoolClient,
  isDeploymentSubdomain,
  BoolAiError,
  BOOL_AI_WIRE_ERROR_CODES,
  isBoolAiWireErrorCode,
  type BoolAiWireErrorCode,
  type BoolClientConfig,
} from "./client";

// Behavioral tests for the gateway client with fetch/sessionStorage stubbed.
// These pin the invariants that make the client correct + secure: REST and
// Storage go through the gateway, everything else passes through, and the
// end-user auth surface stores/replays the preview session token correctly.

const CONFIG: BoolClientConfig = {
  supabaseUrl: "https://upstream.supabase.test",
  supabaseAnonKey: "anon-key",
  schema: "bool_abc",
  appHost: "bool.test",
  appOrigin: "https://bool.test",
  slug: "my-app",
};

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let respond: (url: string, init?: RequestInit) => Response;

const sessionStore = new Map<string, string>();

beforeEach(() => {
  calls = [];
  respond = () =>
    new Response("[]", { headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;

  sessionStore.clear();
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => void sessionStore.set(k, String(v)),
    removeItem: (k: string) => void sessionStore.delete(k),
  };
  delete (globalThis as any).location;
});

function headersOf(call: Call): Headers {
  return new Headers(call.init?.headers);
}

async function tick() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("gateway routing", () => {
  test("REST calls go through the gateway, cross-origin (preview / custom domain)", async () => {
    const client = createBoolClient(CONFIG);
    await client.db.from("todos").select("*");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://bool.test/served/my-app/_bool/v1/db/rest/v1/todos?select=*",
    );
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  test("REST calls use a same-origin relative path when deployed at <slug>.<host>", async () => {
    (globalThis as any).location = { host: "my-app.bool.test" };
    const client = createBoolClient(CONFIG);
    await client.db.from("todos").select("*");
    expect(calls[0]!.url).toBe("/_bool/v1/db/rest/v1/todos?select=*");
  });

  test("stays same-origin when the live subdomain differs from the baked slug (renamed app)", async () => {
    // The bundle was built with slug "my-app" but the project was later renamed
    // to "renamed-app". The proxy resolves the gateway slug from the host, so a
    // relative path still reaches the right gateway. Comparing the live host to
    // the baked slug (the old behavior) routed cross-origin to /served/my-app,
    // which no longer exists → 404 (the "Continue with Google 404s" bug).
    (globalThis as any).location = { host: "renamed-app.bool.test" };
    const client = createBoolClient(CONFIG);
    await client.db.from("todos").select("*");
    expect(calls[0]!.url).toBe("/_bool/v1/db/rest/v1/todos?select=*");
  });

  test("Storage calls go through the gateway too", async () => {
    const client = createBoolClient(CONFIG);
    await client.db.storage.from("uploads").list();
    expect(calls[0]!.url).toStartWith(
      "https://bool.test/served/my-app/_bool/v1/db/storage/v1/object/list/uploads",
    );
  });

  test("non-REST/Storage calls pass through to Supabase untouched", async () => {
    respond = () =>
      new Response("{}", { headers: { "content-type": "application/json" } });
    const client = createBoolClient(CONFIG);
    await client.db.functions.invoke("hello");
    expect(calls[0]!.url).toBe("https://upstream.supabase.test/functions/v1/hello");
  });

  test("the viewer token rides gateway calls as x-bool-viewer (preview only)", async () => {
    const client = createBoolClient({ ...CONFIG, viewerToken: "vt-123" });
    await client.db.from("todos").select("*");
    expect(headersOf(calls[0]!).get("x-bool-viewer")).toBe("vt-123");
  });

  test("no Authorization bearer is added to gateway data calls — data auth is the gateway's job", async () => {
    const client = createBoolClient(CONFIG);
    await client.db.from("todos").select("*");
    // supabase-js sets its own headers; the proxy must not add a bearer of the
    // anon key beyond what supabase-js does with apikey.
    expect(headersOf(calls[0]!).get("apikey")).toBe("anon-key");
  });
});

describe("end-user auth (gateway users plane)", () => {
  const USER = {
    id: "u1",
    email: "a@b.c",
    displayName: null,
    provider: "password" as const,
    emailVerified: false,
    createdAt: "2026-01-01T00:00:00Z",
  };

  test("signUp posts to /users/signup, stores the preview session token, notifies listeners", async () => {
    respond = () => Response.json({ user: USER, sessionToken: "eu-tok" });
    const client = createBoolClient(CONFIG);
    const events: unknown[][] = [];
    client.auth.onAuthStateChange((event, user) => events.push([event, user]));
    await tick(); // initial getUser fire
    calls = [];

    const { data, error } = await client.auth.signUp({ email: "a@b.c", password: "pw123456" });
    expect(error).toBeNull();
    expect(data.user).toEqual(USER);
    expect(calls[0]!.url).toBe("https://bool.test/served/my-app/_bool/v1/users/signup");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(sessionStore.get("bool_eu_session_token")).toBe("eu-tok");
    expect(events.at(-1)).toEqual(["SIGNED_IN", USER]);
  });

  test("the stored session token replays on later calls via x-bool-eu-session", async () => {
    respond = () => Response.json({ user: USER, sessionToken: "eu-tok" });
    const client = createBoolClient(CONFIG);
    await client.auth.signInWithPassword({ email: "a@b.c", password: "pw123456" });
    calls = [];

    respond = () => Response.json({ user: USER });
    await client.auth.getUser();
    expect(headersOf(calls[0]!).get("x-bool-eu-session")).toBe("eu-tok");

    respond = () => new Response("[]", { headers: { "content-type": "application/json" } });
    calls = [];
    await client.db.from("todos").select("*");
    expect(headersOf(calls[0]!).get("x-bool-eu-session")).toBe("eu-tok");
  });

  test("a session token already in sessionStorage is picked up at creation (preview reload)", async () => {
    sessionStore.set("bool_eu_session_token", "persisted-tok");
    const client = createBoolClient(CONFIG);
    respond = () => Response.json({ user: USER });
    await client.auth.getUser();
    expect(headersOf(calls[0]!).get("x-bool-eu-session")).toBe("persisted-tok");
  });

  test("failed login returns the error body and notifies nobody", async () => {
    respond = () => Response.json({ error: "invalid_login" }, { status: 401 });
    const client = createBoolClient(CONFIG);
    const events: unknown[] = [];
    client.auth.onAuthStateChange((event) => events.push(event));
    await tick();
    const before = events.length;

    const { data, error } = await client.auth.signInWithPassword({
      email: "a@b.c",
      password: "nope",
    });
    expect(data.user).toBeNull();
    expect(error).toEqual({ error: "invalid_login" });
    expect(events.length).toBe(before);
    expect(sessionStore.has("bool_eu_session_token")).toBeFalse();
  });

  test("signOut hits /users/logout, clears the session token, notifies SIGNED_OUT", async () => {
    respond = () => Response.json({ user: USER, sessionToken: "eu-tok" });
    const client = createBoolClient(CONFIG);
    await client.auth.signInWithPassword({ email: "a@b.c", password: "pw123456" });

    const events: unknown[][] = [];
    client.auth.onAuthStateChange((event, user) => events.push([event, user]));
    await tick();
    calls = [];

    respond = () => Response.json({ ok: true });
    await client.auth.signOut();
    expect(calls[0]!.url).toBe("https://bool.test/served/my-app/_bool/v1/users/logout");
    expect(sessionStore.has("bool_eu_session_token")).toBeFalse();
    expect(events.at(-1)).toEqual(["SIGNED_OUT", null]);
  });

  test("onAuthStateChange fires once with the current session, and unsubscribe stops updates", async () => {
    respond = () => Response.json({ error: "unauthorized" }, { status: 401 });
    const client = createBoolClient(CONFIG);
    const events: unknown[][] = [];
    const { data } = client.auth.onAuthStateChange((event, user) => events.push([event, user]));
    await tick();
    expect(events).toEqual([["SIGNED_OUT", null]]);

    data.subscription.unsubscribe();
    respond = () => Response.json({ user: USER, sessionToken: "t" });
    await client.auth.signInWithPassword({ email: "a@b.c", password: "pw123456" });
    expect(events).toHaveLength(1);
  });

  test("onAuthStateChange still fires SIGNED_OUT when the session check rejects (no hang)", async () => {
    // A cross-origin / network failure makes the /users/me fetch reject. Without
    // a .catch the callback never fires, `loading` never clears, and <AuthGate>
    // hangs on a blank screen forever — which is what left project-card
    // screenshots capturing an empty background. Treat a rejection as signed-out.
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const client = createBoolClient(CONFIG);
    const events: unknown[][] = [];
    client.auth.onAuthStateChange((event, user) => events.push([event, user]));
    await tick();
    expect(events).toEqual([["SIGNED_OUT", null]]);
  });

  test("resetPasswordForEmail always resolves ok (no account probing), even on server error", async () => {
    respond = () => new Response("boom", { status: 500 });
    const client = createBoolClient(CONFIG);
    const { error } = await client.auth.resetPasswordForEmail("a@b.c");
    expect(error).toBeNull();
    expect(calls[0]!.url).toBe(
      "https://bool.test/served/my-app/_bool/v1/users/reset/request",
    );
  });

  test("confirmPasswordReset signs the user in on success", async () => {
    respond = () => Response.json({ user: USER, sessionToken: "fresh-tok" });
    const client = createBoolClient(CONFIG);
    const { data, error } = await client.auth.confirmPasswordReset({
      token: "reset-token",
      password: "newpw12345",
    });
    expect(error).toBeNull();
    expect(data.user).toEqual(USER);
    expect(calls[0]!.url).toBe(
      "https://bool.test/served/my-app/_bool/v1/users/reset/confirm",
    );
    expect(sessionStore.get("bool_eu_session_token")).toBe("fresh-tok");
  });
});

describe("per-user API key", () => {
  test("getUser passes the gateway's apiKey field through on the user", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          user: { id: "u1", email: "a@b.c", apiKey: "boolk_abc123" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const client = createBoolClient(CONFIG);
    const { data } = await client.auth.getUser();
    expect((data.user as any).apiKey).toBe("boolk_abc123");
  });

  test("rotateApiKey POSTs the rotate route and returns the fresh key", async () => {
    respond = () =>
      new Response(JSON.stringify({ apiKey: "boolk_fresh456" }), {
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const { data, error } = await client.auth.rotateApiKey();
    expect(error).toBeNull();
    expect(data.apiKey).toBe("boolk_fresh456");
    expect(calls[0]!.url).toBe(
      "https://bool.test/served/my-app/_bool/v1/users/api-key/rotate",
    );
    expect(calls[0]!.init?.method).toBe("POST");
  });

  test("rotateApiKey surfaces a 503 (keys not configured) as an error, null key", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "api_keys_not_configured" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const { data, error } = await client.auth.rotateApiKey();
    expect(data.apiKey).toBeNull();
    expect(error).toEqual({ error: "api_keys_not_configured" });
  });
});

describe("local development (config.apiKey)", () => {
  const LOCAL = { ...CONFIG, apiKey: "boolsk_admin123" };

  test("db calls carry the api_key header", async () => {
    const client = createBoolClient(LOCAL);
    await client.db.from("todos").select("*");
    expect(headersOf(calls[0]!).get("api_key")).toBe("boolsk_admin123");
  });

  test("users-plane calls carry the api_key header", async () => {
    respond = () =>
      new Response(JSON.stringify({ user: { id: "u1" } }), {
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(LOCAL);
    await client.auth.getUser();
    expect(headersOf(calls[0]!).get("api_key")).toBe("boolsk_admin123");
  });

  test("ai-plane calls carry the api_key header", async () => {
    respond = () =>
      new Response(JSON.stringify({ text: "hi" }), {
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(LOCAL);
    await client.ai.generate("hello");
    expect(headersOf(calls[0]!).get("api_key")).toBe("boolsk_admin123");
  });

  test("no api_key header without the config option", async () => {
    const client = createBoolClient(CONFIG);
    await client.db.from("todos").select("*");
    expect(headersOf(calls[0]!).get("api_key")).toBeNull();
  });
});

describe("bool.ai battery", () => {
  test("generate(prompt) POSTs to the ai plane and returns text", async () => {
    respond = () =>
      new Response(JSON.stringify({ text: "a summary" }), {
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const out = await client.ai.generate("summarize this");
    expect(out).toBe("a summary");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://bool.test/served/my-app/_bool/v1/ai/generate");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ prompt: "summarize this" });
  });

  test("generate({prompt, schema}) sends the schema and returns the object", async () => {
    respond = () =>
      new Response(JSON.stringify({ object: { sentiment: "positive" } }), {
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const out = await client.ai.generate<{ sentiment: string }>({
      prompt: "rate this",
      schema: { type: "object", properties: { sentiment: { type: "string" } } },
    });
    expect(out).toEqual({ sentiment: "positive" });
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.schema).toEqual({ type: "object", properties: { sentiment: { type: "string" } } });
  });

  test("generate throws BoolAiError carrying status + code on failure", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "out_of_app_credits" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err).toBeInstanceOf(BoolAiError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("out_of_app_credits");
  });

  test("app_credit_daily_cap surfaces as a 429 with retryAfter as a Date", async () => {
    respond = () =>
      new Response(
        JSON.stringify({ error: "app_credit_daily_cap", retryAfter: "2026-08-06T00:00:00.000Z" }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.code).toBe("app_credit_daily_cap");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBeInstanceOf(Date);
    expect(err.retryAfter?.toISOString()).toBe("2026-08-06T00:00:00.000Z");
  });

  test("app_credit_daily_cap on stream carries retryAfter too", async () => {
    respond = () =>
      new Response(
        JSON.stringify({ error: "app_credit_daily_cap", retryAfter: "2026-08-06T00:00:00.000Z" }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    const client = createBoolClient(CONFIG);
    const err = await (async () => {
      try {
        for await (const _ of client.ai.stream("hi")) void _;
      } catch (e) {
        return e as BoolAiError;
      }
    })();
    expect(err?.code).toBe("app_credit_daily_cap");
    expect(err?.retryAfter?.toISOString()).toBe("2026-08-06T00:00:00.000Z");
  });

  test("a code with no retryAfter leaves the field undefined", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfter).toBeUndefined();
  });

  test("isBoolAiWireErrorCode accepts every known code and rejects others", () => {
    for (const code of BOOL_AI_WIRE_ERROR_CODES) {
      expect(isBoolAiWireErrorCode(code)).toBe(true);
    }
    expect(isBoolAiWireErrorCode("unknown_error")).toBe(false);
    expect(isBoolAiWireErrorCode("some_future_code")).toBe(false);
    expect(isBoolAiWireErrorCode("")).toBe(false);
    // A near-miss: the kind of typo the closed union exists to catch.
    expect(isBoolAiWireErrorCode("out_of_app_credit")).toBe(false);
  });

  // Pins the list against the gateway's ai-route.ts. If a code is added there,
  // this is the test that should fail and send someone to update the array.
  test("the wire code list matches the AI plane, exactly", () => {
    expect([...BOOL_AI_WIRE_ERROR_CODES].sort()).toEqual([
      "ai_failed",
      "ai_unavailable",
      "app_credit_daily_cap",
      "invalid_json",
      "method_not_allowed",
      "missing_prompt",
      "not_found",
      "out_of_app_credits",
      "payload_too_large",
      "rate_limited",
    ]);
  });

  test("a thrown error's code narrows to the closed union", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "app_credit_daily_cap" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    if (!isBoolAiWireErrorCode(err.code)) throw new Error("expected a known code");
    // Inside the guard the compiler sees the closed union, so this switch is
    // exhaustiveness-checked — the `never` default is the assertion.
    const label: string = ((code: BoolAiWireErrorCode): string => {
      switch (code) {
        case "app_credit_daily_cap":
          return "daily cap";
        case "out_of_app_credits":
          return "out of credits";
        case "rate_limited":
        case "payload_too_large":
        case "missing_prompt":
        case "invalid_json":
        case "method_not_allowed":
        case "not_found":
        case "ai_unavailable":
        case "ai_failed":
          return "other";
        default: {
          const exhaustive: never = code;
          return exhaustive;
        }
      }
    })(err.code);
    expect(label).toBe("daily cap");
  });

  // The gateway sends `retryAfter: null` (not an absent key) for a credit code
  // whose period has no known end.
  test("an explicit null retryAfter is treated as no hint", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "out_of_app_credits", retryAfter: null }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.code).toBe("out_of_app_credits");
    expect(err.retryAfter).toBeUndefined();
  });

  // rate_limited expresses retryAfter as SECONDS while the credit codes send an
  // ISO instant. Both must reach app code as one type.
  test("rate_limited's seconds form normalizes to an absolute Date", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "rate_limited", retryAfter: 45 }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const before = Date.now();
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.retryAfter).toBeInstanceOf(Date);
    const delta = err.retryAfter!.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(45_000);
    expect(delta).toBeLessThan(50_000);
  });

  test("retryAfter: 0 is a Date (retry now), not a dropped field", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "rate_limited", retryAfter: 0 }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.retryAfter).toBeInstanceOf(Date);
  });

  test("a negative retryAfter is dropped rather than yielding a past Date", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "rate_limited", retryAfter: -5 }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.retryAfter).toBeUndefined();
  });

  // new Date("45") is the year 2045, not 45 seconds from now — a digits-only
  // string must take the seconds path, not the instant path.
  // The shared plane preamble answers some 403/404s in text/plain, so there is
  // no code to read. That must NOT masquerade as ai_failed (a real 502 code
  // apps retry on) — a 404 retried forever is the bug that would cause.
  test("a text/plain body yields unknown_error, not ai_failed", async () => {
    respond = () => new Response("Not found", { status: 404 });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.status).toBe(404);
    expect(err.code).toBe("unknown_error");
  });

  test("a genuine ai_failed 502 still surfaces as ai_failed", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "ai_failed" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.code).toBe("ai_failed");
  });

  // The gateway ships independently of this package, so an app on an older SDK
  // can meet a code this build has never heard of. Pass it through verbatim.
  test("an unrecognized code passes through rather than being flattened", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "some_future_code" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.code).toBe("some_future_code");
  });

  test("a digits-only string retryAfter is read as seconds, not as a year", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "rate_limited", retryAfter: "45" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const before = Date.now();
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    const delta = err.retryAfter!.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(45_000);
    expect(delta).toBeLessThan(50_000);
  });

  test("an unparseable retryAfter is dropped rather than surfaced as Invalid Date", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "app_credit_daily_cap", retryAfter: "soon" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err.retryAfter).toBeUndefined();
  });

  test("stream yields decoded text chunks", async () => {
    respond = () => new Response("Hello, world");
    const client = createBoolClient(CONFIG);
    let acc = "";
    for await (const chunk of client.ai.stream("tell me a story")) acc += chunk;
    expect(acc).toBe("Hello, world");
    expect(calls[0]!.url).toBe("https://bool.test/served/my-app/_bool/v1/ai/stream");
    expect(calls[0]!.init?.method).toBe("POST");
  });

  test("stream throws BoolAiError on a non-ok response", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const iter = client.ai.stream("go");
    const err = await iter[Symbol.asyncIterator]().next().catch((e) => e);
    expect(err).toBeInstanceOf(BoolAiError);
    expect((err as BoolAiError).code).toBe("rate_limited");
  });

  test("replays the preview viewer token as x-bool-viewer", async () => {
    respond = () =>
      new Response(JSON.stringify({ text: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient({ ...CONFIG, viewerToken: "viewer-123" });
    await client.ai.generate("hi");
    expect(headersOf(calls[0]!).get("x-bool-viewer")).toBe("viewer-123");
  });
});

// The registry has to be a singleton across module INSTANCES, not just within
// one. Regression coverage for a real break: a generated app imported
// `createBoolClient` from "bool-sdk" and `useEntity` from "bool-sdk/react",
// nothing imported the bootstrap module at all, and every hook threw "No Bool
// client exists yet" at first render.
describe("default client registry", () => {
  test("the last-created client is the default (hot reload re-registers)", () => {
    const first = createBoolClient(CONFIG);
    expect(getDefaultBoolClient()).toBe(first);
    const second = createBoolClient(CONFIG);
    expect(getDefaultBoolClient()).toBe(second);
  });

  test("lives on a globalThis symbol, so a duplicated client.js shares it", () => {
    // Simulates the second bundle: another copy of this module would read the
    // same well-known symbol rather than its own module-scoped variable.
    const client = createBoolClient(CONFIG);
    const shared = (globalThis as any)[Symbol.for("bool-sdk.defaultClient")];
    expect(shared).toBe(client);
  });

  test("hasDefaultBoolClient reports registration without throwing", () => {
    createBoolClient(CONFIG);
    expect(hasDefaultBoolClient()).toBe(true);
  });

  test("the unregistered error names the exact fix (the import to add)", () => {
    const saved = (globalThis as any)[Symbol.for("bool-sdk.defaultClient")];
    (globalThis as any)[Symbol.for("bool-sdk.defaultClient")] = null;
    try {
      expect(hasDefaultBoolClient()).toBe(false);
      // The old message said "call createBoolClient() first", which is useless
      // to someone whose app already calls it in a module nothing imports.
      expect(() => getDefaultBoolClient()).toThrow(/import ".\/lib\/supabase"/);
      expect(() => getDefaultBoolClient()).toThrow(/src\/main\.tsx/);
    } finally {
      (globalThis as any)[Symbol.for("bool-sdk.defaultClient")] = saved;
    }
  });
});

// The doorbell's lifecycle is fully covered with fake deps in realtime.test.ts;
// here we pin the WIRING: subscribing asks the gateway's wristband desk at the
// right URL with credentials, and tearing down while the mint is in flight
// orphans it (no channel ever joins).
describe("subscribeToChanges wiring (private doorbell)", () => {
  test("POSTs the mint URL with credentials; immediate unsubscribe orphans the start", async () => {
    let mintCalls = 0;
    respond = (url) => {
      if (url.includes("/_bool/v1/realtime/token")) {
        mintCalls++;
        return Response.json({
          token: "t",
          expiresIn: 900,
          topics: { app: "bool:app_x:app", user: null },
        });
      }
      return new Response("[]", { headers: { "content-type": "application/json" } });
    };
    const client = createBoolClient({ ...CONFIG, viewerToken: "vt-9" });
    const off = client.subscribeToChanges(() => {});
    off(); // torn down before the mint resolves
    await tick();
    expect(mintCalls).toBe(1);
    const call = calls.find((c) => c.url.includes("/_bool/v1/realtime/token"))!;
    expect(call.url).toBe("https://bool.test/served/my-app/_bool/v1/realtime/token");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.credentials).toBe("include");
    expect(headersOf(call).get("x-bool-viewer")).toBe("vt-9");
  });
});

describe("isDeploymentSubdomain", () => {
  test("any single-label subdomain of appHost qualifies — not just the baked slug", () => {
    expect(isDeploymentSubdomain("my-app.bool.test", "bool.test")).toBe(true);
    expect(isDeploymentSubdomain("renamed-app.bool.test", "bool.test")).toBe(true);
    expect(isDeploymentSubdomain("a1b2c3.bool.test", "bool.test")).toBe(true);
  });

  test("ignores a :port so it holds in local dev", () => {
    expect(isDeploymentSubdomain("my-app.bool.test:3010", "bool.test")).toBe(true);
  });

  test("the bare apex is not a deployment subdomain", () => {
    expect(isDeploymentSubdomain("bool.test", "bool.test")).toBe(false);
  });

  test("multi-label hosts don't qualify (proxy only rewrites single-label)", () => {
    expect(isDeploymentSubdomain("foo.bar.bool.test", "bool.test")).toBe(false);
  });

  test("a different registrable domain (custom domain / preview sandbox) is cross-origin", () => {
    expect(isDeploymentSubdomain("my-app.example.com", "bool.test")).toBe(false);
    expect(isDeploymentSubdomain("abc123.vercel.run", "bool.test")).toBe(false);
  });

  test("empty inputs are safe", () => {
    expect(isDeploymentSubdomain("", "bool.test")).toBe(false);
    expect(isDeploymentSubdomain("my-app.bool.test", "")).toBe(false);
  });
});
