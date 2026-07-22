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

  test("filter() maps scalar, $-operator, array, and null to PostgREST ops", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.filter({
      status: "active",
      count: { $gte: 100 },
      priority: ["high", "urgent"],
      archived_at: null,
    });
    const q = reqQuery(calls[0]!);
    expect(q.get("status")).toBe("eq.active");
    expect(q.get("count")).toBe("gte.100");
    expect(q.get("priority")).toBe("in.(high,urgent)");
    expect(q.get("archived_at")).toBe("is.null");
  });

  test("filter() maps the richer Mongo-style operators", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.filter({
      a: { $ne: 1 },
      b: { $nin: [2, 3] },
      c: { $exists: true },
      d: { $exists: false },
      e: { $regex: "^x" },
      tags: { $all: ["red", "blue"] },
    });
    const q = reqQuery(calls[0]!);
    expect(q.get("a")).toBe("neq.1");
    expect(q.get("b")).toBe("not.in.(2,3)");
    expect(q.get("c")).toBe("not.is.null");
    expect(q.get("d")).toBe("is.null");
    expect(q.get("e")).toBe("match.^x");
    expect(q.get("tags")).toBe("cs.{red,blue}");
  });

  test("filter() supports root $or", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.filter({ $or: [{ status: "active" }, { priority: { $gte: 3 } }] });
    expect(reqQuery(calls[0]!).get("or")).toBe("(status.eq.active,priority.gte.3)");
  });

  test("filter() $not negates a single inner operator", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.filter({ age: { $not: { $gt: 18 } } });
    expect(reqQuery(calls[0]!).get("age")).toBe("not.gt.18");
  });

  test("filter() $nor negates every sub-condition (De Morgan, valid PostgREST)", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.filter({ $nor: [{ status: "done" }, { pinned: true }] });
    const q = reqQuery(calls[0]!);
    // NOR = NOT status=done AND NOT pinned=true — two negated params, no garbage.
    expect(q.get("status")).toBe("not.eq.done");
    expect(q.get("pinned")).toBe("not.eq.true");
    expect(new URL(calls[0]!.url).search).not.toContain("undefined");
  });

  test("filter() $and merges nested sub-queries", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.filter({ $and: [{ status: "active" }, { priority: { $gte: 3 } }] });
    const q = reqQuery(calls[0]!);
    expect(q.get("status")).toBe("eq.active");
    expect(q.get("priority")).toBe("gte.3");
  });

  test("filter() ignores unsupported $size rather than emitting bad SQL", async () => {
    const bool = createBoolClient(CONFIG);
    // $size is intentionally unsupported (not in the type) — cast to prove it's
    // silently dropped rather than emitting invalid SQL.
    await bool.entities.todos.filter({ tags: { $size: 3 } } as any);
    expect(new URL(calls[0]!.url).search).not.toContain("size");
    expect(new URL(calls[0]!.url).search).not.toContain("undefined");
  });

  test("sort accepts an explicit + prefix for ascending", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.list("+title");
    expect(reqQuery(calls[0]!).get("order")).toBe("title.asc");
  });

  test("list() allows an explicit limit up to the max (5000)", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.list("-created_at", 5000);
    expect(reqQuery(calls[0]!).get("limit")).toBe("5000");
  });

  test("list() throws on an over-cap limit instead of silently truncating", async () => {
    const bool = createBoolClient(CONFIG);
    await expect(bool.entities.todos.list("-created_at", 5001)).rejects.toThrow(/maximum/i);
    // It fails before touching the network — no partial/truncated request goes out.
    expect(calls).toHaveLength(0);
  });

  test("filter() defaults to the same 50-row page", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.filter({ status: "active" });
    const q = reqQuery(calls[0]!);
    expect(q.get("status")).toBe("eq.active");
    expect(q.get("limit")).toBe("50");
  });

  test("fields limits the selected columns", async () => {
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.list("-created_at", 50, 0, ["id", "title"]);
    expect(reqQuery(calls[0]!).get("select")).toBe("id,title");
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

  test("delete(id) DELETEs the matched row and reports success", async () => {
    const bool = createBoolClient(CONFIG);
    const res = await bool.entities.todos.delete("t1");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(reqQuery(calls[0]!).get("id")).toBe("eq.t1");
    expect(res).toEqual({ success: true });
  });

  test("bulkCreate() inserts an array in one POST", async () => {
    respond = () => Response.json([{ id: "a" }, { id: "b" }]);
    const bool = createBoolClient(CONFIG);
    const rows = await bool.entities.todos.bulkCreate([{ title: "a" }, { title: "b" }]);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual([{ title: "a" }, { title: "b" }]);
    expect(rows).toHaveLength(2);
  });

  test("bulkUpdate() upserts rows by id", async () => {
    respond = () => Response.json([{ id: "a", done: true }]);
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.bulkUpdate([{ id: "a", done: true }]);
    // Upsert is a POST with an on-conflict resolution / merge preference.
    expect(calls[0]!.init?.method).toBe("POST");
    const prefer = new Headers(calls[0]!.init?.headers).get("prefer") ?? "";
    expect(prefer).toContain("resolution=merge-duplicates");
  });

  test("updateMany() with $set is one atomic PATCH", async () => {
    respond = () => Response.json([{ id: "a" }, { id: "b" }]);
    const bool = createBoolClient(CONFIG);
    const res = await bool.entities.todos.updateMany({ status: "pending" }, { $set: { status: "done" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(reqQuery(calls[0]!).get("status")).toBe("eq.pending");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ status: "done" });
    expect(res).toEqual({ success: true, updated: 2, has_more: false });
  });

  test("updateMany() with a plain object is treated as $set", async () => {
    respond = () => Response.json([{ id: "a" }]);
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.updateMany({ id: "a" }, { done: true });
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ done: true });
  });

  test("updateMany() with $inc selects ids then calls the atomic RPC", async () => {
    respond = (url) =>
      url.includes("/rpc/bool_apply_numeric")
        ? new Response(null, { status: 204 })
        : Response.json([{ id: "a" }, { id: "b" }]); // the id SELECT
    const bool = createBoolClient(CONFIG);
    const res = await bool.entities.posts.updateMany({ topic: "x" }, { $inc: { views: 1 } });
    // 1) select matching ids
    expect(new URL(calls[0]!.url).pathname).toEndWith("/rest/v1/posts");
    expect(reqQuery(calls[0]!).get("select")).toBe("id");
    // 2) POST the RPC with the ids + operators — the increment happens in SQL
    const rpc = calls.find((c) => c.url.includes("/rpc/bool_apply_numeric"))!;
    expect(rpc.init?.method).toBe("POST");
    expect(JSON.parse(String(rpc.init?.body))).toEqual({
      p_table: "posts",
      p_ids: ["a", "b"],
      p_inc: { views: 1 },
      p_mul: null,
    });
    expect(res.updated).toBe(2);
  });

  test("updateMany() $inc falls back to read-modify-write when the RPC is missing (PGRST202)", async () => {
    respond = (url) => {
      if (url.includes("/rpc/bool_apply_numeric")) {
        return Response.json({ code: "PGRST202", message: "function not found" }, { status: 404 });
      }
      // the id SELECT, then the read of full rows, then the upsert
      return Response.json([{ id: "a", views: 5 }]);
    };
    const bool = createBoolClient(CONFIG);
    const res = await bool.entities.posts.updateMany({ id: "a" }, { $inc: { views: 1 } });
    // After the RPC 404s, it reads the rows and upserts the incremented value.
    const upsert = calls.find(
      (c) => c.init?.method === "POST" && !c.url.includes("/rpc/"),
    )!;
    expect(JSON.parse(String(upsert.init?.body))).toEqual([{ id: "a", views: 6 }]);
    expect(res.updated).toBe(1);
  });

  test("updateMany() with $mul goes through the atomic RPC", async () => {
    respond = (url) =>
      url.includes("/rpc/bool_apply_numeric")
        ? new Response(null, { status: 204 })
        : Response.json([{ id: "a" }]);
    const bool = createBoolClient(CONFIG);
    await bool.entities.posts.updateMany({ id: "a" }, { $mul: { score: 2 } });
    const rpc = calls.find((c) => c.url.includes("/rpc/bool_apply_numeric"))!;
    expect(JSON.parse(String(rpc.init?.body))).toEqual({
      p_table: "posts",
      p_ids: ["a"],
      p_inc: null,
      p_mul: { score: 2 },
    });
  });

  test("updateMany() with $unset PATCHes the columns to null (one atomic call)", async () => {
    respond = () => Response.json([{ id: "a" }]);
    const bool = createBoolClient(CONFIG);
    await bool.entities.todos.updateMany({ id: "a" }, { $unset: { note: true } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ note: null });
  });

  test("updateMany() with $set + $inc PATCHes the set fields then calls the RPC for the arithmetic", async () => {
    respond = (url) =>
      url.includes("/rpc/bool_apply_numeric")
        ? new Response(null, { status: 204 })
        : Response.json([{ id: "a" }]);
    const bool = createBoolClient(CONFIG);
    await bool.entities.posts.updateMany({ id: "a" }, { $set: { status: "hot" }, $inc: { views: 1 } });
    const patch = calls.find((c) => c.init?.method === "PATCH")!;
    expect(JSON.parse(String(patch.init?.body))).toEqual({ status: "hot" });
    const rpc = calls.find((c) => c.url.includes("/rpc/bool_apply_numeric"))!;
    expect(JSON.parse(String(rpc.init?.body)).p_inc).toEqual({ views: 1 });
  });

  test("updateMany() with $push read-modify-writes the array (documented non-atomic)", async () => {
    respond = (url, init) => {
      if (init?.method === "POST") return Response.json([{ id: "a", tags: ["x", "y"] }]);
      return Response.json([{ id: "a", tags: ["x"] }]); // the SELECT
    };
    const bool = createBoolClient(CONFIG);
    await bool.entities.posts.updateMany({ id: "a" }, { $push: { tags: "y" } });
    const upsert = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(String(upsert.init?.body))).toEqual([{ id: "a", tags: ["x", "y"] }]);
  });

  test("updateMany() with $pull removes the value from the array", async () => {
    respond = (url, init) => {
      if (init?.method === "POST") return Response.json([{ id: "a", tags: ["x"] }]);
      return Response.json([{ id: "a", tags: ["x", "y"] }]);
    };
    const bool = createBoolClient(CONFIG);
    await bool.entities.posts.updateMany({ id: "a" }, { $pull: { tags: "y" } });
    const upsert = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(String(upsert.init?.body))).toEqual([{ id: "a", tags: ["x"] }]);
  });

  test("deleteMany() deletes matching rows and counts them", async () => {
    respond = () => Response.json([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const bool = createBoolClient(CONFIG);
    const res = await bool.entities.todos.deleteMany({ done: true });
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(reqQuery(calls[0]!).get("done")).toBe("eq.true");
    expect(res).toEqual({ success: true, deleted: 3 });
  });

  test("importEntities() parses CSV client-side and bulk-creates", async () => {
    const created: unknown[] = [];
    respond = (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        created.push(...body);
        return Response.json(body);
      }
      return new Response("[]");
    };
    const bool = createBoolClient(CONFIG);
    const csv = 'title,done\n"Buy, milk",false\n"Say ""hi""",true\n';
    const file = new File([csv], "todos.csv", { type: "text/csv" });
    const res = await bool.entities.todos.importEntities(file);
    expect(res.status).toBe("success");
    expect(created).toEqual([
      { title: "Buy, milk", done: "false" },
      { title: 'Say "hi"', done: "true" },
    ]);
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
