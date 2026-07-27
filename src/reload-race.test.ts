import { beforeEach, describe, expect, test } from "bun:test";
import { createBoolClient, type BoolClientConfig, type BoolChangePayload } from "./client";

// The reload race that makes rows pop out and back in.
//
// The app reloads its whole list on every doorbell ping. A reload issued while
// the app's own writes are still in flight comes back WITHOUT them, and replaces
// what's on screen — so rows the user already added vanish until the next ping.
// The SDK holds the ping until its own writes drain, then fires once.
//
// These drive the real client with `fetch` stubbed, and control exactly when each
// write resolves, so the race is deterministic rather than timing-dependent.

const CONFIG: BoolClientConfig = {
  supabaseUrl: "https://upstream.supabase.test",
  supabaseAnonKey: "anon-key",
  schema: "bool_abc",
  appOrigin: "https://bool.test",
  slug: "my-app",
};

/** Writes park until released, so "in flight" is something we decide. */
let releases: Array<() => void> = [];
let respond: (url: string, init?: RequestInit) => Response;

beforeEach(() => {
  releases = [];
  respond = () => new Response("[]", { headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      await new Promise<void>((r) => releases.push(r));
    }
    return respond(url, init);
  }) as unknown as typeof fetch;
  (globalThis as any).sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  delete (globalThis as any).location;
});

/** Swap in a fake channel so no WebSocket is opened, and capture the handler the
 * client registers so tests can deliver pings by hand. */
function instrument(client: ReturnType<typeof createBoolClient>) {
  const seen = { handler: null as null | ((msg: unknown) => void), removed: 0 };
  (client.db as any).channel = () => {
    const ch: any = {
      on: (_e: string, _f: unknown, cb: (msg: unknown) => void) => {
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

const tick = () => new Promise((r) => setTimeout(r, 0));
/** Longer than PING_COALESCE_MS (50ms) so a scheduled flush has run. */
const afterCoalesce = () => new Promise((r) => setTimeout(r, 90));

function ping(seen: { handler: null | ((m: unknown) => void) }, payload: BoolChangePayload = {}) {
  seen.handler!({ payload });
}

describe("reload is withheld while this client's writes are in flight", () => {
  test("a ping during an in-flight write does not reload until it settles", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let reloads = 0;
    client.subscribeToChanges(() => reloads++);

    // Start a write and leave it pending.
    void client.entities.todos.create({ text: "a" });
    await tick();

    ping(seen); // the doorbell fires for the row that just committed
    await afterCoalesce();
    expect(reloads).toBe(0); // withheld — a reload here would drop optimistic rows

    releases.forEach((r) => r()); // the write settles
    await afterCoalesce();
    expect(reloads).toBe(1); // ...and now exactly one reload
  });

  // The reported bug: three quick adds. Every ping lands while later writes are
  // still in flight, so all of them must collapse into a single reload at the end.
  test("three rapid writes collapse to ONE reload, after the last settles", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let reloads = 0;
    client.subscribeToChanges(() => reloads++);

    void client.entities.todos.create({ text: "a" });
    void client.entities.todos.create({ text: "b" });
    void client.entities.todos.create({ text: "c" });
    await tick();
    expect(releases).toHaveLength(3);

    // Each commit pings while the others are still outstanding.
    releases[0]!();
    ping(seen);
    await tick();
    releases[1]!();
    ping(seen);
    await tick();
    expect(reloads).toBe(0);

    releases[2]!();
    ping(seen);
    await afterCoalesce();
    expect(reloads).toBe(1);
  });

  test("with nothing in flight a ping reloads promptly", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let reloads = 0;
    client.subscribeToChanges(() => reloads++);

    ping(seen);
    await afterCoalesce();
    expect(reloads).toBe(1);
  });

  // The trigger fires per changed ROW, so a bulk write produces a burst of pings
  // for what the app should treat as one refresh.
  test("a burst of pings coalesces into one reload", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let reloads = 0;
    client.subscribeToChanges(() => reloads++);

    for (let i = 0; i < 10; i++) ping(seen);
    await afterCoalesce();
    expect(reloads).toBe(1);
  });

  test("the latest payload wins when pings coalesce", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    const got: BoolChangePayload[] = [];
    client.subscribeToChanges((p) => got.push(p));

    ping(seen, { table: "todos", op: "INSERT" });
    ping(seen, { table: "todos", op: "DELETE" });
    await afterCoalesce();
    expect(got).toEqual([{ table: "todos", op: "DELETE" }]);
  });

  test("a failed write still releases the hold", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let reloads = 0;
    client.subscribeToChanges(() => reloads++);

    respond = () => new Response("boom", { status: 500 });
    void client.entities.todos.create({ text: "a" }).catch(() => {});
    await tick();
    ping(seen);
    await afterCoalesce();
    expect(reloads).toBe(0);

    releases.forEach((r) => r());
    await afterCoalesce();
    expect(reloads).toBe(1); // the counter must not leak on failure
  });

  test("reads never hold anything back", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let reloads = 0;
    client.subscribeToChanges(() => reloads++);

    void client.entities.todos.list(); // GET — must not count as a write
    await tick();
    ping(seen);
    await afterCoalesce();
    expect(reloads).toBe(1);
  });

  test("unsubscribing cancels a pending reload", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let reloads = 0;
    const stop = client.subscribeToChanges(() => reloads++);

    ping(seen);
    stop(); // before the coalesce window elapses
    await afterCoalesce();
    expect(reloads).toBe(0);
    expect(seen.removed).toBe(1);
  });

  // Raw supabase-js is the style SYNC_GUIDANCE_V2 actually teaches most apps, so
  // it has to be counted too — which is why writes are tracked in proxyFetch
  // rather than in the entities layer.
  test("a raw supabase.from().insert() is counted as a write", async () => {
    const client = createBoolClient(CONFIG);
    const seen = instrument(client);
    let reloads = 0;
    client.subscribeToChanges(() => reloads++);

    // supabase-js builders are thenable — they don't issue the request until
    // awaited, so this needs a .then() to actually fire.
    void client.db
      .from("todos")
      .insert({ text: "a" })
      .then(() => {});
    await tick();
    expect(releases).toHaveLength(1); // the write really is in flight

    ping(seen);
    await afterCoalesce();
    expect(reloads).toBe(0);

    releases.forEach((r) => r());
    await afterCoalesce();
    expect(reloads).toBe(1);
  });
});
