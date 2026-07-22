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
      flags: { project: "p1", "api-url": "https://x", verbose: true },
    });
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
