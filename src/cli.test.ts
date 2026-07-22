import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CONFIG_FILE, ENV_FILE, collectDeployEntries, isDeployExcluded, parseArgs, runCli } from "./cli.js";

const CONNECTION = {
  projectId: "p1",
  name: "My App",
  slug: "my-app",
  schema: "app_abc123",
  appOrigin: "https://bool.so",
  appUrl: "https://my-app.bool.so",
  supabaseUrl: "https://apps.supabase.test",
  supabaseAnonKey: "anon-key",
};

type Call = { url: string; init?: RequestInit };

function makeDeps(cwd: string, routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const deps = {
    cwd,
    env: { BOOL_TOKEN: "bool_live_test" } as Record<string, string | undefined>,
    log: (m: string) => logs.push(m),
    error: (m: string) => errors.push(m),
    sleep: async () => {},
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const path = url.startsWith("http") ? new URL(url).pathname : url;
      const handler = routes[path];
      if (!handler) return new Response(JSON.stringify({ error: "no route " + path }), { status: 404 });
      return handler(init);
    },
  };
  return { deps, calls, logs, errors };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "bool-cli-"));
});

describe("parseArgs", () => {
  test("parses command and flag forms", () => {
    expect(parseArgs(["link", "--project", "p1", "--api-url=https://x", "--verbose"])).toEqual({
      command: "link",
      positionals: [],
      flags: { project: "p1", "api-url": "https://x", verbose: true },
    });
  });
  test("captures subcommand positionals", () => {
    expect(parseArgs(["entities", "push", "--dir", "x"])).toEqual({
      command: "entities",
      positionals: ["push"],
      flags: { dir: "x" },
    });
  });
});

describe("create", () => {
  function createRoutes() {
    return {
      "/api/projects": () =>
        json({ id: "new1", name: "My Todo" }, 201),
      "/api/projects/new1/connection": () =>
        json({ ...CONNECTION, projectId: "new1", name: "My Todo" }),
      "/api/projects/new1/api-key": () => json({ apiKey: "boolsk_secret" }),
      "/api/projects/new1/entities": () =>
        json({ ok: true, entity: "todos", changed: true, warnings: [] }),
      "/api/projects/new1/entities/types": () => new Response("// todo types"),
    };
  }

  test("creates a project, scaffolds a todo app, links, pushes the entity", async () => {
    const { deps, calls, logs } = makeDeps(cwd, createRoutes());
    const code = await runCli(["create", "my-todo"], deps);
    expect(code).toBe(0);

    const dir = join(cwd, "my-todo");
    // Scaffolded app files.
    expect(existsSync(join(dir, "package.json"))).toBe(true);
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("my-todo");
    expect(readFileSync(join(dir, "src/App.tsx"), "utf8")).toContain("bool.entities.todos");
    const entity = readFileSync(join(dir, "bool/entities/todos.jsonc"), "utf8");
    expect(entity).toContain('"x-bool-access": "public"');

    // Linked into the new dir (config + secret key), not the cwd.
    const config = JSON.parse(readFileSync(join(dir, CONFIG_FILE), "utf8"));
    expect(config.projectId).toBe("new1");
    expect(existsSync(join(cwd, CONFIG_FILE))).toBe(false);
    expect(readFileSync(join(dir, ENV_FILE), "utf8")).toBe("BOOL_API_KEY=boolsk_secret\n");

    // Created the project and declared the entity.
    expect(calls.some((c) => c.url.endsWith("/api/projects") && c.init?.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/api/projects/new1/entities") && c.init?.method === "POST")).toBe(true);
    // No deploy without --deploy.
    expect(calls.some((c) => c.url.includes("/api/drops"))).toBe(false);
    expect(logs.join("\n")).toContain('Created project "My Todo"');
  });

  test("aborts before deploy when the entity push fails", async () => {
    const routes = createRoutes();
    routes["/api/projects/new1/entities"] = () =>
      new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405 });
    const { deps, calls, errors } = makeDeps(cwd, routes);
    expect(await runCli(["create", "my-todo", "--deploy"], deps)).toBe(1);
    // Never deployed a broken app.
    expect(calls.some((c) => c.url.includes("/api/drops"))).toBe(false);
    expect(errors.join("\n")).toContain("bool entities push");
  });

  test("refuses a non-empty target directory", async () => {
    const dir = join(cwd, "taken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.txt"), "x");
    const { deps, errors, calls } = makeDeps(cwd, createRoutes());
    expect(await runCli(["create", "taken"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("isn't empty");
    // Bailed before creating anything server-side.
    expect(calls.length).toBe(0);
  });

  test("generates a name when none is given (bare `bool create`)", async () => {
    const { deps, logs } = makeDeps(cwd, createRoutes());
    expect(await runCli(["create"], deps)).toBe(0);
    // A project was created and something got scaffolded under a generated name.
    expect(logs.join("\n")).toMatch(/Created project ".+"/);
    expect(logs.join("\n")).toMatch(/Scaffolded a todo app in [a-z]+-[a-z]+-\d+\//);
  });

  test("fails fast (no scaffold) when the new project isn't a gateway project", async () => {
    const routes = createRoutes();
    routes["/api/projects/new1/connection"] = () =>
      json({ error: "not_gateway_project", message: "This project runs on the v1 runtime" }, 409);
    const { deps, calls, errors } = makeDeps(cwd, routes);

    expect(await runCli(["create", "my-todo"], deps)).toBe(1);
    // Surfaces the server's reason plus the reassurance that nothing was written.
    expect(errors.join("\n")).toContain("v1 runtime");
    expect(errors.join("\n")).toContain("nothing was scaffolded");
    // No files scaffolded — the target dir was never created.
    expect(existsSync(join(cwd, "my-todo"))).toBe(false);
    // Bailed at the connection check: never scaffolded, linked, or pushed.
    expect(calls.some((c) => c.url.endsWith("/api/projects/new1/api-key"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/api/projects/new1/entities"))).toBe(false);
  });
});

describe("link", () => {
  test("writes config + env + gitignore and pulls types", async () => {
    const { deps, calls, logs } = makeDeps(cwd, {
      "/api/projects/p1/connection": () => json(CONNECTION),
      "/api/projects/p1/api-key": () => json({ apiKey: "boolsk_secret" }),
      "/api/projects/p1/entities/types": () => new Response("// types here"),
    });
    const code = await runCli(["link", "--project", "p1", "--api-url", "https://bool.test"], deps);
    expect(code).toBe(0);

    const config = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8"));
    expect(config).toMatchObject({
      projectId: "p1",
      slug: "my-app",
      apiUrl: "https://bool.test",
      schema: "app_abc123",
      supabaseAnonKey: "anon-key",
      typesPath: "bool/types.d.ts",
    });
    // The secret goes to .env.bool (gitignored), never into the config.
    expect(JSON.stringify(config)).not.toContain("boolsk_secret");
    expect(readFileSync(join(cwd, ENV_FILE), "utf8")).toBe("BOOL_API_KEY=boolsk_secret\n");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toContain(ENV_FILE);
    expect(readFileSync(join(cwd, "bool/types.d.ts"), "utf8")).toBe("// types here");

    // Platform calls carry the PAT.
    for (const c of calls) {
      expect(new Headers(c.init?.headers).get("authorization")).toBe("Bearer bool_live_test");
    }
    expect(logs.join("\n")).toContain("Linked to \"My App\"");
  });

  test("still links when the api key is owner-only (404)", async () => {
    const { deps, logs } = makeDeps(cwd, {
      "/api/projects/p1/connection": () => json(CONNECTION),
      "/api/projects/p1/api-key": () => json({ error: "Not found" }, 404),
      "/api/projects/p1/entities/types": () => new Response("// t"),
    });
    expect(await runCli(["link", "--project", "p1"], deps)).toBe(0);
    expect(existsSync(join(cwd, ENV_FILE))).toBe(false);
    expect(logs.join("\n")).toContain("Skipped the admin data key");
  });

  test("fails without a token", async () => {
    const { deps, errors } = makeDeps(cwd, {});
    deps.env = {};
    expect(await runCli(["link", "--project", "p1"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("BOOL_TOKEN");
  });

  test("surfaces a connection error (v1 project)", async () => {
    const { deps, errors } = makeDeps(cwd, {
      "/api/projects/p1/connection": () =>
        json({ error: "not_gateway_project", message: "This project runs on the v1 runtime" }, 409),
    });
    expect(await runCli(["link", "--project", "p1"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("v1 runtime");
  });

  // Regression: a 200 with a non-JSON body (e.g. --api-url points at a host
  // that serves the HTML app shell because the Bool API isn't deployed there)
  // must fail cleanly, not crash on `conn.projectId`.
  test("fails cleanly when the API returns a non-JSON 200 (wrong --api-url)", async () => {
    const { deps, errors } = makeDeps(cwd, {
      "/api/projects/p1/connection": () =>
        new Response("<!DOCTYPE html><html><body>app</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    expect(await runCli(["link", "--project", "p1", "--api-url", "https://not-the-api.test"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("--api-url");
    expect(errors.join("\n")).not.toContain("projectId");
  });
});

describe("types", () => {
  test("refreshes the types file from config", async () => {
    writeFileSync(
      join(cwd, CONFIG_FILE),
      JSON.stringify({ ...CONNECTION, apiUrl: "https://bool.test", typesPath: "bool/types.d.ts" }),
    );
    const { deps } = makeDeps(cwd, {
      "/api/projects/p1/entities/types": () => new Response("// fresh"),
    });
    expect(await runCli(["types", "--out", "custom/entities.d.ts"], deps)).toBe(0);
    expect(readFileSync(join(cwd, "custom/entities.d.ts"), "utf8")).toBe("// fresh");
  });

  test("requires a link first", async () => {
    const { deps, errors } = makeDeps(cwd, {});
    expect(await runCli(["types"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("bool link");
  });
});

describe("deploy exclusions", () => {
  test("excludes deps, VCS, build output, env files, and the link config", () => {
    for (const p of [
      "node_modules/react/index.js",
      ".git/HEAD",
      "dist/bundle.js",
      "build/x",
      ".next/y",
      ".env",
      ".env.bool",
      ".env.local",
      "bool.config.json",
      "src/.DS_Store",
    ]) {
      expect(isDeployExcluded(p)).toBe(true);
    }
    for (const p of ["index.html", "src/main.ts", "package.json", "bool/types.d.ts", "public/env-info.txt"]) {
      expect(isDeployExcluded(p)).toBe(false);
    }
  });

  test("collectDeployEntries walks the tree with exclusions applied", () => {
    writeFileSync(join(cwd, "index.html"), "<html/>");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src/main.ts"), "code");
    mkdirSync(join(cwd, "node_modules/x"), { recursive: true });
    writeFileSync(join(cwd, "node_modules/x/i.js"), "dep");
    writeFileSync(join(cwd, ".env.bool"), "BOOL_API_KEY=secret");
    writeFileSync(join(cwd, CONFIG_FILE), "{}");
    const paths = collectDeployEntries(cwd).map((e) => e.path);
    expect(paths).toEqual(["index.html", "src/main.ts"]);
  });
});

describe("deploy", () => {
  test("zips, uploads, polls to ready", async () => {
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ ...CONNECTION, apiUrl: "https://bool.test" }));
    writeFileSync(join(cwd, "index.html"), "<html/>");
    let polls = 0;
    const { deps, calls, logs } = makeDeps(cwd, {
      "/api/drops": (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ project_id: "p1" });
        return json({
          drop_id: "d1",
          upload_url: "https://storage.test/upload/d1",
          upload_headers: { "Content-Type": "application/zip" },
          status_url: "https://bool.test/api/drops/d1/status?sig=x",
          max_upload_size_bytes: 10_000_000,
        });
      },
      "/upload/d1": () => new Response(null, { status: 200 }),
      "/api/drops/d1/status": () =>
        ++polls < 3
          ? json({ status: "building", url: null, error: null })
          : json({ status: "ready", url: "https://my-app.bool.so", error: null }),
    });
    expect(await runCli(["deploy"], deps)).toBe(0);
    expect(polls).toBe(3);
    // The upload PUT carried zip bytes.
    const put = calls.find((c) => c.url.includes("/upload/d1"))!;
    expect(put.init?.method).toBe("PUT");
    expect(logs.join("\n")).toContain("Live at https://my-app.bool.so");
  });

  test("reports a failed build", async () => {
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ ...CONNECTION, apiUrl: "https://bool.test" }));
    writeFileSync(join(cwd, "index.html"), "<html/>");
    const { deps, errors } = makeDeps(cwd, {
      "/api/drops": () =>
        json({
          drop_id: "d1",
          upload_url: "https://storage.test/upload/d1",
          upload_headers: {},
          status_url: "https://bool.test/api/drops/d1/status",
          max_upload_size_bytes: 10_000_000,
        }),
      "/upload/d1": () => new Response(null, { status: 200 }),
      "/api/drops/d1/status": () =>
        json({ status: "failed", url: null, error: { code: "BUILD_FAILED", message: "vite exited 1" } }),
    });
    expect(await runCli(["deploy"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("vite exited 1");
  });

  test("refuses a directory without index.html", async () => {
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ ...CONNECTION, apiUrl: "https://bool.test" }));
    const { deps, errors } = makeDeps(cwd, {});
    expect(await runCli(["deploy"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("index.html");
  });
});

describe("entities", () => {
  test("prints the entity reference", async () => {
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ ...CONNECTION, apiUrl: "https://bool.test" }));
    const { deps, logs } = makeDeps(cwd, {
      "/api/projects/p1/entities": () =>
        json({
          entities: [
            {
              name: "todos",
              access: "private",
              fields: [
                { name: "id", type: "string", required: true },
                { name: "title", type: "string", required: true },
              ],
            },
          ],
        }),
    });
    expect(await runCli(["entities"], deps)).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("todos (private)");
    expect(out).toContain("title: string (required)");
  });
});

describe("entities push / pull", () => {
  const BANNER = "// Data model managed by Bool.\n";

  test("push declares every local schema and refreshes types", async () => {
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ ...CONNECTION, apiUrl: "https://bool.test", typesPath: "bool/types.d.ts" }));
    mkdirSync(join(cwd, "bool/entities"), { recursive: true });
    writeFileSync(
      join(cwd, "bool/entities/todos.jsonc"),
      BANNER +
        JSON.stringify({
          name: "todos",
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          "x-bool-access": "private",
        }),
    );
    writeFileSync(
      join(cwd, "bool/entities/games.jsonc"),
      BANNER + JSON.stringify({ name: "games", type: "object", properties: { score: { type: "number" } }, "x-bool-access": "public" }),
    );
    const pushed: unknown[] = [];
    const { deps, logs } = makeDeps(cwd, {
      "/api/projects/p1/entities": (init) => {
        const body = JSON.parse(String(init?.body));
        pushed.push(body);
        return json({ ok: true, entity: body.name, changed: body.name === "todos", warnings: body.name === "todos" ? ["heads up"] : [] });
      },
      "/api/projects/p1/entities/types": () => new Response("// regenerated"),
    });
    expect(await runCli(["entities", "push"], deps)).toBe(0);
    // Alphabetical file order; access carried through from x-bool-access.
    expect(pushed.map((p) => (p as { name: string }).name)).toEqual(["games", "todos"]);
    expect((pushed[0] as { access: string }).access).toBe("public");
    expect((pushed[1] as { access: string; required: string[] }).required).toEqual(["title"]);
    const out = logs.join("\n");
    expect(out).toContain("✓ todos: migrated");
    expect(out).toContain("✓ games: already up to date");
    expect(out).toContain("⚠ heads up");
    expect(readFileSync(join(cwd, "bool/types.d.ts"), "utf8")).toBe("// regenerated");
  });

  test("push reports per-entity failures and exits 1", async () => {
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ ...CONNECTION, apiUrl: "https://bool.test" }));
    mkdirSync(join(cwd, "bool/entities"), { recursive: true });
    writeFileSync(join(cwd, "bool/entities/bad.jsonc"), "{ not json");
    writeFileSync(
      join(cwd, "bool/entities/ok.jsonc"),
      JSON.stringify({ name: "ok", properties: { a: { type: "string" } } }),
    );
    const { deps, errors } = makeDeps(cwd, {
      "/api/projects/p1/entities": () => json({ ok: true, entity: "ok", changed: false, warnings: [] }),
      "/api/projects/p1/entities/types": () => new Response("// t"),
    });
    expect(await runCli(["entities", "push"], deps)).toBe(1);
    expect(errors.join("\n")).toContain("✗ bad.jsonc");
    expect(errors.join("\n")).toContain("1 of 2 entities failed");
  });

  test("pull writes the raw schema files and refreshes types", async () => {
    writeFileSync(join(cwd, CONFIG_FILE), JSON.stringify({ ...CONNECTION, apiUrl: "https://bool.test", typesPath: "bool/types.d.ts" }));
    const { deps, errors } = makeDeps(cwd, {
      "/api/projects/p1/entities/schemas": () =>
        json({
          schemas: [
            { path: "bool/entities/todos.jsonc", content: '// banner\n{"name":"todos"}' },
            { path: "../pull-escape-evil.txt", content: "evil" },
          ],
        }),
      "/api/projects/p1/entities/types": () => new Response("// t"),
    });
    expect(await runCli(["entities", "pull"], deps)).toBe(0);
    expect(readFileSync(join(cwd, "bool/entities/todos.jsonc"), "utf8")).toBe('// banner\n{"name":"todos"}');
    // A hostile path from the network is skipped, never written.
    expect(errors.join("\n")).toContain("Skipping unexpected path");
    expect(existsSync(join(cwd, "../pull-escape-evil.txt"))).toBe(false);
  });
});

describe("help / unknown", () => {
  test("no command prints usage and exits 1", async () => {
    const { deps, logs } = makeDeps(cwd, {});
    expect(await runCli([], deps)).toBe(1);
    expect(logs.join("\n")).toContain("Usage:");
  });
  test("unknown command errors", async () => {
    const { deps, errors } = makeDeps(cwd, {});
    expect(await runCli(["frobnicate"], deps)).toBe(1);
    expect(errors.join("\n")).toContain('Unknown command "frobnicate"');
  });
});
