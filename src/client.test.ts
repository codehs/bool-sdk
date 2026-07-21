import { beforeEach, describe, expect, test } from "bun:test";
import {
  createBoolClient,
  getDefaultBoolClient,
  BoolAiError,
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
      new Response(JSON.stringify({ error: "out_of_ai_credits" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    const client = createBoolClient(CONFIG);
    const err = (await client.ai.generate("hi").catch((e) => e)) as BoolAiError;
    expect(err).toBeInstanceOf(BoolAiError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("out_of_ai_credits");
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

describe("default client registry", () => {
  test("the last-created client is the default (hot reload re-registers)", () => {
    const first = createBoolClient(CONFIG);
    expect(getDefaultBoolClient()).toBe(first);
    const second = createBoolClient(CONFIG);
    expect(getDefaultBoolClient()).toBe(second);
  });
});
