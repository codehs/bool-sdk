import { beforeEach, describe, expect, test } from "bun:test";
import { createBoolClient, type BoolClientConfig } from "./client";

// These drive the entities layer through the REAL supabase-js query builder and
// assert the PostgREST request it produces (routed through the gateway). So we
// verify the actual translation — filter/sort/pagination → query string — not a
// hand-mocked builder.

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

/** The gateway path prefix for this app's DB plane. */
const DB = "https://bool.test/served/my-app/_bool/v1/db/rest/v1";

/** Decode the query string of the single recorded call for readable asserts. */
function reqQuery(call: Call): URLSearchParams {
  return new URL(call.url).searchParams;
}

describe("entities: read paths → PostgREST", () => {
  test("list() selects the table, defaults to newest-first, limit 50", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.list();
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/served/my-app/_bool/v1/db/rest/v1/todos");
    expect(reqQuery(calls[0]!).get("select")).toBe("*");
    expect(reqQuery(calls[0]!).get("order")).toBe("created_at.desc");
    // range(0, 49) → limit 50 from offset 0
    expect(reqQuery(calls[0]!).get("limit")).toBe("50");
    expect(reqQuery(calls[0]!).get("offset")).toBe("0");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  test("list() honors ascending sort, custom limit + offset", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.list("title", 10, 20);
    expect(reqQuery(calls[0]!).get("order")).toBe("title.asc");
    expect(reqQuery(calls[0]!).get("limit")).toBe("10");
    expect(reqQuery(calls[0]!).get("offset")).toBe("20");
  });

  test("filter() maps scalar, operator, array, and null to PostgREST ops", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.filter({
      status: "active",
      count: { gte: 100 },
      priority: ["high", "urgent"],
      archived_at: null,
    });
    const q = reqQuery(calls[0]!);
    expect(q.get("status")).toBe("eq.active");
    expect(q.get("count")).toBe("gte.100");
    expect(q.get("priority")).toBe("in.(high,urgent)");
    expect(q.get("archived_at")).toBe("is.null");
  });

  test("get(id) fetches one row by id", async () => {
    respond = () => Response.json({ id: "t1", title: "hi" });
    const bool = createBoolClient(CONFIG);
    const row = await bool.entities.todos.get("t1");
    expect(reqQuery(calls[0]!).get("id")).toBe("eq.t1");
    expect(row).toEqual({ id: "t1", title: "hi" });
  });

  test("list() returns the rows and unwraps the array", async () => {
    respond = () => Response.json([{ id: "a" }, { id: "b" }]);
    const bool = createBoolClient(CONFIG);
    const rows = await bool.entities.todos.list();
    expect(rows).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("entities: write paths → PostgREST", () => {
  test("create() POSTs the row and returns the created record", async () => {
    respond = (_url, init) =>
      init?.method === "POST"
        ? Response.json({ id: "new", title: "hi" })
        : new Response("[]");
    const bool = createBoolClient(CONFIG);
    const created = await bool.entities.todos.create({ title: "hi" });
    expect(calls[0]!.init?.method).toBe("POST");
    expect(new URL(calls[0]!.url).pathname).toEndWith("/rest/v1/todos");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ title: "hi" });
    expect(created).toEqual({ id: "new", title: "hi" });
  });

  test("update(id, patch) PATCHes the matched row", async () => {
    respond = () => Response.json({ id: "t1", done: true });
    const bool = createBoolClient(CONFIG);
    const updated = await bool.entities.todos.update("t1", { done: true });
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(reqQuery(calls[0]!).get("id")).toBe("eq.t1");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ done: true });
    expect(updated).toEqual({ id: "t1", done: true });
  });

  test("delete(id) DELETEs the matched row", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.delete("t1");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(reqQuery(calls[0]!).get("id")).toBe("eq.t1");
  });
});

describe("entities: errors + ergonomics", () => {
  test("a PostgREST error is thrown, not returned", async () => {
    respond = () =>
      Response.json(
        { message: "permission denied", code: "42501" },
        { status: 403, headers: { "content-type": "application/json" } },
      );
    const bool = createBoolClient(CONFIG);
    await expect(bool.entities.todos.list()).rejects.toBeDefined();
  });

  test("the same handler instance is reused per table name", () => {
    const bool = createBoolClient(CONFIG);
    expect(bool.entities.todos).toBe(bool.entities.todos);
    expect(bool.entities.todos).not.toBe(bool.entities.notes);
  });

  test("awaiting the module itself doesn't create a `then` entity", () => {
    const bool = createBoolClient(CONFIG);
    expect((bool.entities as any).then).toBeUndefined();
  });
});
