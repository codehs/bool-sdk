import { beforeEach, describe, expect, test } from "bun:test";
import { createBoolClient, type BoolClientConfig, type BoolChangePayload } from "./client";

// The realtime doorbell: token minting, the public fallback that keeps this SDK
// working against an older Bool, and subscribeRows' single-row fetch.
//
// No WebSocket is involved. We stub `client.db.channel` and
// `client.db.realtime.setAuth` after construction — subscribeToChanges closes
// over the same `db` object, so the stubs are what it calls.

const CONFIG: BoolClientConfig = {
  supabaseUrl: "https://upstream.supabase.test",
  supabaseAnonKey: "anon-key",
  schema: "bool_abc",
  appOrigin: "https://bool.test",
  slug: "my-app",
};

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let respond: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  calls = [];
  respond = () => new Response("[]", { headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  (globalThis as any).sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  delete (globalThis as any).location;
});

const TOKEN_URL = "https://bool.test/served/my-app/_bool/v1/realtime/token";

/** Replace the realtime bits of a client and capture what it does. */
function instrument(client: ReturnType<typeof createBoolClient>) {
  const seen = {
    setAuth: [] as string[],
    channels: [] as { topic: string; opts: unknown }[],
    removed: 0,
    handler: null as null | ((msg: unknown) => void),
  };
  (client.db as any).realtime = {
    setAuth: async (t: string) => void seen.setAuth.push(t),
  };
  (client.db as any).channel = (topic: string, opts?: unknown) => {
    seen.channels.push({ topic, opts });
    const ch: any = {
      on: (_ev: string, _filter: unknown, cb: (msg: unknown) => void) => {
        seen.handler = cb;
        return ch;
      },
      subscribe: () => ch,
    };
    return ch;
  };
  (client.db as any).removeChannel = async () => void seen.removed++;
  return seen;
}

/** Let the async subscribe setup (token mint) settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("doorbell token", () => {
  test("mints a token and joins the channel PRIVATE", async () => {
    respond = (url) =>
      url === TOKEN_URL
        ? new Response(JSON.stringify({ token: "rt-tok", expiresIn: 3600 }), {
            headers: { "content-type": "application/json" },
          })
        : new Response("[]", { headers: { "content-type": "application/json" } });

    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    client.subscribeToChanges(() => {});
    await settle();

    expect(calls.some((c) => c.url === TOKEN_URL)).toBe(true);
    expect(calls.find((c) => c.url === TOKEN_URL)!.init?.credentials).toBe("include");
    expect(seen.setAuth).toEqual(["rt-tok"]);
    expect(seen.channels).toHaveLength(1);
    expect(seen.channels[0]!.topic).toBe("bool:bool_abc");
    expect(seen.channels[0]!.opts).toEqual({ config: { private: true } });
  });

  // The compatibility guarantee: an app can pick up this SDK before the platform
  // ships the realtime plane, so a missing route must degrade, not break.
  test("404 on the token route falls back to a PUBLIC subscribe", async () => {
    respond = (url) =>
      url === TOKEN_URL
        ? new Response("Not found", { status: 404 })
        : new Response("[]", { headers: { "content-type": "application/json" } });

    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    client.subscribeToChanges(() => {});
    await settle();

    expect(seen.setAuth).toEqual([]); // no token → never authenticate
    expect(seen.channels[0]!.opts).toBeUndefined(); // → public, as before
  });

  test("a network failure also falls back rather than throwing", async () => {
    respond = (url) => {
      if (url === TOKEN_URL) throw new Error("offline");
      return new Response("[]", { headers: { "content-type": "application/json" } });
    };

    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    expect(() => client.subscribeToChanges(() => {})).not.toThrow();
    await settle();
    expect(seen.channels[0]!.opts).toBeUndefined();
  });

  test("the token is reused across subscriptions, not re-minted per channel", async () => {
    respond = (url) =>
      url === TOKEN_URL
        ? new Response(JSON.stringify({ token: "rt-tok", expiresIn: 3600 }), {
            headers: { "content-type": "application/json" },
          })
        : new Response("[]", { headers: { "content-type": "application/json" } });

    const client = createBoolClient(CONFIG);
    instrument(client);
    client.subscribeToChanges(() => {});
    await settle();
    client.subscribeToChanges(() => {});
    await settle();

    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  const tokenOk = (url: string) =>
    url === TOKEN_URL
      ? new Response(JSON.stringify({ token: "rt-tok", expiresIn: 3600 }), {
          headers: { "content-type": "application/json" },
        })
      : new Response("[]", { headers: { "content-type": "application/json" } });

  test("unsubscribing before the mint resolves never opens a channel", async () => {
    respond = tokenOk;
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    const stop = client.subscribeToChanges(() => {});
    stop(); // synchronously, while the token fetch is still in flight
    await settle();
    // Nothing to tear down because nothing was opened — that's the guarantee.
    expect(seen.channels).toHaveLength(0);
    expect(seen.removed).toBe(0);
  });

  // The narrow race: cancelled after the token arrives but before the channel is
  // assigned, so the channel opens with nobody holding a reference to it.
  test("unsubscribing mid-authentication tears down the channel that opens after", async () => {
    respond = tokenOk;
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let release!: () => void;
    (client.db as any).realtime = {
      setAuth: async (t: string) => {
        seen.setAuth.push(t);
        await new Promise<void>((r) => (release = r));
      },
    };

    const stop = client.subscribeToChanges(() => {});
    await settle(); // token resolved; now parked inside setAuth
    expect(seen.setAuth).toEqual(["rt-tok"]);
    stop(); // cancel while authenticating
    release(); // let setAuth finish, so the channel gets created
    await settle();

    expect(seen.channels).toHaveLength(1);
    expect(seen.removed).toBe(1); // ...and immediately removed, not leaked
  });
});

describe("subscribeRows", () => {
  function setup() {
    respond = (url) => {
      if (url === TOKEN_URL) return new Response("Not found", { status: 404 });
      // `get` uses .single(), so PostgREST answers with a BARE OBJECT, and with
      // 406/PGRST116 when nothing matches.
      if (url.includes("id=eq.row-1")) {
        return new Response(JSON.stringify({ id: "row-1", text: "fetched" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("id=eq.row-missing")) {
        return new Response(
          JSON.stringify({ code: "PGRST116", message: "0 rows" }),
          { status: 406, headers: { "content-type": "application/json" } },
        );
      }
      // Deliberately the wrong shape for .single(), to exercise the guard.
      if (url.includes("id=eq.row-empty")) {
        return new Response("[]", { headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { headers: { "content-type": "application/json" } });
    };
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    const got: unknown[] = [];
    client.entities.todos.subscribeRows((c) => got.push(c));
    return { client, seen, got };
  }

  async function ping(seen: ReturnType<typeof instrument>, payload: BoolChangePayload) {
    await settle();
    seen.handler!({ payload });
    await settle();
  }

  test("fetches only the changed row, by id", async () => {
    const { seen, got } = setup();
    await ping(seen, { table: "todos", op: "INSERT", id: "row-1" });

    const reads = calls.filter((c) => c.url.includes("/rest/v1/todos") && c.url.includes("id=eq."));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.url).toContain("id=eq.row-1");
    // Crucially NOT a full-table read — that's the reload that causes flicker.
    expect(calls.some((c) => c.url.includes("order=created_at"))).toBe(false);
    expect(got).toEqual([{ op: "INSERT", id: "row-1", row: { id: "row-1", text: "fetched" } }]);
  });

  test("DELETE reports null without fetching", async () => {
    const { seen, got } = setup();
    await ping(seen, { table: "todos", op: "DELETE", id: "row-1" });
    expect(calls.some((c) => c.url.includes("id=eq."))).toBe(false);
    expect(got).toEqual([{ op: "DELETE", id: "row-1", row: null }]);
  });

  test("a row that isn't readable yields null instead of throwing", async () => {
    const { seen, got } = setup();
    await ping(seen, { table: "todos", op: "UPDATE", id: "row-missing" });
    expect(got).toEqual([{ op: "UPDATE", id: "row-missing", row: null }]);
  });

  // Guard: an empty array is not a row. Passing it through would corrupt a merge
  // (`[row, ...prev]` would splice an array into the list).
  test("a non-row response shape is normalized to null", async () => {
    const { seen, got } = setup();
    await ping(seen, { table: "todos", op: "UPDATE", id: "row-empty" });
    expect(got).toEqual([{ op: "UPDATE", id: "row-empty", row: null }]);
  });

  // Older schemas still emit {table, op} with no id. Report it so the app can
  // fall back to a reload, rather than dropping the change on the floor.
  test("a payload with no id reports id:null", async () => {
    const { seen, got } = setup();
    await ping(seen, { table: "todos", op: "INSERT" });
    expect(calls.some((c) => c.url.includes("id=eq."))).toBe(false);
    expect(got).toEqual([{ op: "INSERT", id: null, row: null }]);
  });

  test("changes to other tables are ignored", async () => {
    const { seen, got } = setup();
    await ping(seen, { table: "other", op: "INSERT", id: "row-1" });
    expect(got).toEqual([]);
    expect(calls.some((c) => c.url.includes("id=eq."))).toBe(false);
  });
});
