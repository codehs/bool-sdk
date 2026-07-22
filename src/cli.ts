// The Bool CLI (`bool`, shipped in the bool-sdk package): develop a LOCAL app
// against a Bool project as its managed backend, then publish it back to Bool.
// Run via `npx bool-sdk <command>` / `bunx bool-sdk`, or just `bool <command>`
// once installed. Zero dependencies — plain fetch + node:fs.
//
//   bool create <name>         scaffold a new Bool todo app + project here,
//                              then link it (add --deploy to publish it too)
//   bool link --project <id>   connect this folder to a Bool project:
//                              writes bool.config.json (public config),
//                              .env.bool (the secret BOOL_API_KEY), and
//                              pulls the generated entity types
//   bool types                 refresh bool/types.d.ts from the project's
//                              entity schemas
//   bool entities              list the project's entities + fields
//   bool entities pull         write the project's schema files to bool/entities/
//   bool entities push         declare local bool/entities/*.jsonc on the
//                              project (additive migrations, server-side)
//   bool deploy [--dir .]      zip the app source and publish it on Bool
//                              (Bool builds in the cloud; the URL is stable)
//
// Auth: platform API calls (link/types/entities/deploy) use a personal access
// token — pass --token or set BOOL_TOKEN (create one in Bool → Settings →
// Access tokens). The app's DATA access uses the project api key `link` puts
// in .env.bool, which the app passes to createBoolClient as `apiKey`.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createZip, type ZipEntry } from "./zip.js";
import { todoTemplate } from "./templates.js";

export const CONFIG_FILE = "bool.config.json";
export const ENV_FILE = ".env.bool";
const DEFAULT_API_URL = "https://bool.com";
const DEFAULT_TYPES_PATH = "bool/types.d.ts";

/** The public, committable half of a link — everything createBoolClient needs
 * except the secret api key (that lives in .env.bool / BOOL_API_KEY). */
export type BoolConfig = {
  projectId: string;
  slug: string;
  apiUrl: string;
  appOrigin: string;
  appUrl: string;
  schema: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  typesPath: string;
};

/** Injectable effects so tests run hermetically (stub fetch, pin cwd/env).
 * `fetch` is a plain fetch-shaped function (not Bun's `typeof fetch`, which
 * demands a `preconnect` property a stub doesn't have — same cast client.ts
 * documents). */
export type CliDeps = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  cwd: string;
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  error: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
};

function defaults(): CliDeps {
  return {
    fetch: (...args) => fetch(...args),
    cwd: process.cwd(),
    env: process.env,
    log: (m) => console.log(m),
    error: (m) => console.error(m),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** Tiny arg parser: `--key value` / `--key=value` / bare `--flag`, plus bare
 * positionals (subcommands like `entities push`). */
export function parseArgs(argv: string[]): {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < rest.length && !rest[i + 1]!.startsWith("--")) {
      flags[arg.slice(2)] = rest[++i]!;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return { command, positionals, flags };
}

class CliError extends Error {}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function token(flags: Record<string, string | boolean>, deps: CliDeps): string {
  const t = str(flags.token) ?? deps.env.BOOL_TOKEN;
  if (!t) {
    throw new CliError(
      "No access token. Pass --token <token> or set BOOL_TOKEN (create one in Bool → Settings → Access tokens).",
    );
  }
  return t;
}

async function api(
  deps: CliDeps,
  tok: string,
  base: string,
  path: string,
): Promise<Response> {
  const res = await deps.fetch(`${base.replace(/\/$/, "")}${path}`, {
    headers: { authorization: `Bearer ${tok}` },
  });
  return res;
}

async function apiJson<T>(
  deps: CliDeps,
  tok: string,
  base: string,
  path: string,
): Promise<T> {
  const res = await api(deps, tok, base, path);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (body as { error?: string; message?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      `HTTP ${res.status}`;
    throw new CliError(`${path} failed: ${msg}`);
  }
  // A 2xx with a body we couldn't parse as a JSON object means we didn't reach
  // the Bool API — most often --api-url points at a host that serves an HTML
  // page (e.g. the app shell when the endpoint isn't deployed there yet, or a
  // login/redirect page). Fail with a clear message instead of returning null
  // and letting the caller crash on `body.projectId`.
  if (body === null || typeof body !== "object") {
    throw new CliError(
      `${path}: expected a JSON response from ${base} but got something else — check --api-url (is the Bool API deployed there?).`,
    );
  }
  return body as T;
}

async function apiPost<T>(
  deps: CliDeps,
  tok: string,
  base: string,
  path: string,
  payload: unknown,
): Promise<T> {
  const res = await deps.fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      (body as { error?: string; message?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      `HTTP ${res.status}`;
    throw new CliError(`${path} failed: ${msg}`);
  }
  if (body === null || typeof body !== "object") {
    throw new CliError(
      `${path}: expected a JSON response from ${base} but got something else — check --api-url (is the Bool API deployed there?).`,
    );
  }
  return body as T;
}

export function readConfig(cwd: string): BoolConfig {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new CliError(
      `No ${CONFIG_FILE} here — run \`bool link --project <id>\` first.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as BoolConfig;
}

/** Idempotently set KEY=value in .env.bool and make sure .gitignore hides it. */
function writeEnvKey(cwd: string, key: string, value: string): void {
  const envPath = join(cwd, ENV_FILE);
  const line = `${key}=${value}`;
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i !== -1) lines[i] = line;
    else lines.push(line);
    writeFileSync(envPath, lines.filter((l, j) => l || j < lines.length - 1).join("\n") + "\n");
  } else {
    writeFileSync(envPath, line + "\n");
  }
  const gitignore = join(cwd, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (!existing.split("\n").some((l) => l.trim() === ENV_FILE)) {
    appendFileSync(
      gitignore,
      (existing && !existing.endsWith("\n") ? "\n" : "") + ENV_FILE + "\n",
    );
  }
}

type Connection = {
  projectId: string;
  name: string;
  slug: string;
  schema: string;
  appOrigin: string;
  appUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
};

// Fetch a project's connection descriptor, write bool.config.json, and (for the
// owner) the admin data key to .env.bool — all into deps.cwd. Returns the config
// so the caller can pull types / push entities against it. Shared by `link` and
// `create`.
async function writeConfigAndKey(
  projectId: string,
  apiUrl: string,
  tok: string,
  typesPath: string,
  deps: CliDeps,
): Promise<{ config: BoolConfig; name: string }> {
  const conn = await apiJson<Connection>(
    deps,
    tok,
    apiUrl,
    `/api/projects/${projectId}/connection`,
  );

  const config: BoolConfig = {
    projectId: conn.projectId,
    slug: conn.slug,
    apiUrl,
    appOrigin: conn.appOrigin,
    appUrl: conn.appUrl,
    schema: conn.schema,
    supabaseUrl: conn.supabaseUrl,
    supabaseAnonKey: conn.supabaseAnonKey,
    typesPath,
  };
  writeFileSync(join(deps.cwd, CONFIG_FILE), JSON.stringify(config, null, 2) + "\n");

  // The admin data key is owner-only; a non-owner link still works for
  // types/entities/deploy, they just bring their own key.
  const keyRes = await api(deps, tok, apiUrl, `/api/projects/${projectId}/api-key`);
  if (keyRes.ok) {
    const { apiKey } = (await keyRes.json()) as { apiKey: string };
    writeEnvKey(deps.cwd, "BOOL_API_KEY", apiKey);
    deps.log(`Wrote the project's admin data key to ${ENV_FILE} (gitignored — keep it secret).`);
  } else {
    deps.log(
      `Skipped the admin data key (${keyRes.status === 404 ? "owner-only" : `HTTP ${keyRes.status}`}) — set BOOL_API_KEY yourself to read/write data locally.`,
    );
  }

  return { config, name: conn.name };
}

async function cmdLink(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
): Promise<number> {
  const projectId = str(flags.project);
  if (!projectId) throw new CliError("Usage: bool link --project <id> [--api-url <url>] [--token <pat>]");
  const apiUrl = str(flags["api-url"]) ?? deps.env.BOOL_API_URL ?? DEFAULT_API_URL;
  const tok = token(flags, deps);

  const typesPath = str(flags.types) ?? DEFAULT_TYPES_PATH;
  const { config, name } = await writeConfigAndKey(projectId, apiUrl, tok, typesPath, deps);
  deps.log(`Linked to "${name}" (${config.projectId}) — wrote ${CONFIG_FILE}.`);

  await pullTypes(config, tok, deps);

  deps.log(`
Next steps:
  1. Load ${ENV_FILE} into your env (or copy BOOL_API_KEY into your own .env).
  2. Create the client:

     import { createBoolClient } from "bool-sdk";
     import config from "./${CONFIG_FILE}";

     export const bool = createBoolClient({
       supabaseUrl: config.supabaseUrl,
       supabaseAnonKey: config.supabaseAnonKey,
       schema: config.schema,
       appOrigin: config.appOrigin,
       slug: config.slug,
       apiKey: process.env.BOOL_API_KEY, // import.meta.env.VITE_BOOL_API_KEY in Vite
     });

  3. Use your data: await bool.entities.<name>.list()
     (admin-key note: creates on a PRIVATE entity must set owner_id explicitly —
      the admin key has no end-user identity to default it from)
  4. Publish anytime: bool deploy`);
  return 0;
}

async function cmdCreate(
  positionals: string[],
  flags: Record<string, string | boolean>,
  deps: CliDeps,
): Promise<number> {
  const name = positionals[0] ?? str(flags.name);
  if (!name) {
    throw new CliError(
      "Usage: bool create <name> [--path <dir>] [--deploy] [--token <pat>]",
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/.test(name)) {
    throw new CliError(
      `Invalid project name "${name}" — use letters, numbers, spaces, dashes, underscores.`,
    );
  }
  const apiUrl = str(flags["api-url"]) ?? deps.env.BOOL_API_URL ?? DEFAULT_API_URL;
  const tok = token(flags, deps);
  const dir = resolve(deps.cwd, str(flags.path) ?? name);

  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new CliError(
      `${relative(deps.cwd, dir) || dir} already exists and isn't empty — pick another name or --path.`,
    );
  }

  // 1. Create the project. template stays vite-react so Bool cloud-builds the
  //    app we deploy; the server also provisions the project's schema.
  const project = await apiPost<{ id: string; name?: string }>(
    deps,
    tok,
    apiUrl,
    "/api/projects",
    { name, template: "vite-react" },
  );
  deps.log(`Created project "${project.name ?? name}" (${project.id}).`);

  // 2. Scaffold the todo app into dir.
  mkdirSync(dir, { recursive: true });
  const files = todoTemplate(name);
  for (const [rel, content] of Object.entries(files)) {
    const out = join(dir, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content);
  }
  deps.log(
    `Scaffolded a todo app in ${relative(deps.cwd, dir) || "."}/ (${Object.keys(files).length} files).`,
  );

  // Everything below runs inside the new project dir.
  const sub: CliDeps = { ...deps, cwd: dir };

  // 3. Write bool.config.json + .env.bool into the project dir.
  const { config } = await writeConfigAndKey(project.id, apiUrl, tok, DEFAULT_TYPES_PATH, sub);
  deps.log(`Linked ${CONFIG_FILE} to project ${project.id}.`);

  // 4. Declare the todos entity so the table exists, then refresh types.
  await cmdEntitiesPush(flags, sub);
  await pullTypes(config, tok, sub);

  // 5. Optionally publish.
  if (flags.deploy) {
    await cmdDeploy(flags, sub);
  } else {
    const rel = relative(deps.cwd, dir) || ".";
    deps.log(`
Next:
  cd ${rel}
  npm install
  npm run dev        # develop locally (data goes to your Bool project)
  bool deploy        # publish to Bool hosting`);
  }
  return 0;
}

async function pullTypes(config: BoolConfig, tok: string, deps: CliDeps): Promise<void> {
  const res = await api(
    deps,
    tok,
    config.apiUrl,
    `/api/projects/${config.projectId}/entities/types`,
  );
  if (!res.ok) throw new CliError(`Fetching entity types failed: HTTP ${res.status}`);
  const body = await res.text();
  const out = resolve(deps.cwd, config.typesPath || DEFAULT_TYPES_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  deps.log(`Wrote entity types to ${relative(deps.cwd, out)}.`);
}

async function cmdTypes(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
): Promise<number> {
  const config = readConfig(deps.cwd);
  if (str(flags.out)) config.typesPath = str(flags.out)!;
  await pullTypes(config, token(flags, deps), deps);
  return 0;
}

/** Where local entity schema files live — the same layout the platform uses
 * inside a project, so pull/push round-trip byte-for-byte. */
export const ENTITIES_DIR = "bool/entities";

/** Parse one local entity `.jsonc` file (JSON with whole-line `//` comments —
 * the platform's banner format). Mirrors the server's parser. */
export function parseEntitySchemaFile(content: string): {
  name: string;
  properties: Record<string, unknown>;
  required?: string[];
  access: "private" | "public";
} | null {
  const stripped = content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  let doc: unknown;
  try {
    doc = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const obj = doc as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.properties || typeof obj.properties !== "object") {
    return null;
  }
  return {
    name: obj.name,
    properties: obj.properties as Record<string, unknown>,
    required: Array.isArray(obj.required)
      ? (obj.required.filter((r) => typeof r === "string") as string[])
      : undefined,
    access: obj["x-bool-access"] === "public" ? "public" : "private",
  };
}

/** `bool entities push`: declare every local bool/entities/*.jsonc on the
 * project (additive-only server-side — it never drops columns), then refresh
 * types. Continues past a bad file and reports it; exits 1 if any failed. */
async function cmdEntitiesPush(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
): Promise<number> {
  const config = readConfig(deps.cwd);
  const tok = token(flags, deps);
  const dir = resolve(deps.cwd, str(flags.dir) ?? ENTITIES_DIR);
  if (!existsSync(dir)) {
    throw new CliError(`No ${relative(deps.cwd, dir)}/ directory — run \`bool entities pull\` first, or create <name>.jsonc files there.`);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonc"))
    .sort();
  if (files.length === 0) {
    throw new CliError(`No .jsonc entity files in ${relative(deps.cwd, dir)}/.`);
  }

  let failed = 0;
  for (const file of files) {
    const parsed = parseEntitySchemaFile(readFileSync(join(dir, file), "utf8"));
    if (!parsed) {
      deps.error(`✗ ${file}: not a valid entity schema (needs "name" + "properties")`);
      failed++;
      continue;
    }
    const res = await deps.fetch(
      `${config.apiUrl.replace(/\/$/, "")}/api/projects/${config.projectId}/entities`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
        body: JSON.stringify(parsed),
      },
    );
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; changed?: boolean; warnings?: string[]; error?: string }
      | null;
    if (!res.ok || !body?.ok) {
      deps.error(`✗ ${parsed.name}: ${body?.error ?? `HTTP ${res.status}`}`);
      failed++;
      continue;
    }
    deps.log(`✓ ${parsed.name}: ${body.changed ? "migrated" : "already up to date"}`);
    for (const w of body.warnings ?? []) deps.log(`  ⚠ ${w}`);
  }

  await pullTypes(config, tok, deps);
  if (failed > 0) {
    deps.error(`${failed} of ${files.length} entities failed to push.`);
    return 1;
  }
  return 0;
}

/** `bool entities pull`: write the project's entity schema files verbatim into
 * bool/entities/ (so they can be edited and pushed back), then refresh types. */
async function cmdEntitiesPull(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
): Promise<number> {
  const config = readConfig(deps.cwd);
  const tok = token(flags, deps);
  const { schemas } = await apiJson<{ schemas: Array<{ path: string; content: string }> }>(
    deps,
    tok,
    config.apiUrl,
    `/api/projects/${config.projectId}/entities/schemas`,
  );
  if (schemas.length === 0) {
    deps.log("The project has no declared entities yet — nothing to pull.");
    return 0;
  }
  for (const s of schemas) {
    // Paths come from the platform (`bool/entities/<name>.jsonc`), but never
    // trust a path from the network with the filesystem: resolve and confine.
    const out = resolve(deps.cwd, s.path);
    if (!out.startsWith(resolve(deps.cwd, ENTITIES_DIR) + "/")) {
      deps.error(`Skipping unexpected path from server: ${s.path}`);
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, s.content);
    deps.log(`✓ ${s.path}`);
  }
  await pullTypes(config, tok, deps);
  return 0;
}

async function cmdEntities(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
): Promise<number> {
  const config = readConfig(deps.cwd);
  const { entities } = await apiJson<{
    entities: Array<{
      name: string;
      access: string;
      fields: Array<{ name: string; type: string; required: boolean }>;
    }>;
  }>(deps, token(flags, deps), config.apiUrl, `/api/projects/${config.projectId}/entities`);
  if (entities.length === 0) {
    deps.log("No entities declared yet — define one in the Bool editor (or via the MCP define_entity tool).");
    return 0;
  }
  for (const e of entities) {
    deps.log(`${e.name} (${e.access})`);
    for (const f of e.fields) {
      deps.log(`  ${f.name}: ${f.type}${f.required ? " (required)" : ""}`);
    }
  }
  return 0;
}

// Never ship these into a deploy archive: build output and deps are rebuilt in
// the cloud; env files and the local link config are machine-local (and the
// env files hold secrets).
const DEPLOY_EXCLUDE_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);
export function isDeployExcluded(rel: string): boolean {
  const top = rel.split("/")[0]!;
  if (DEPLOY_EXCLUDE_DIRS.has(top)) return true;
  const base = rel.split("/").pop()!;
  if (base === CONFIG_FILE) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === ".DS_Store") return true;
  return false;
}

export function collectDeployEntries(dir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name);
      const rel = relative(dir, child).split("\\").join("/");
      if (isDeployExcluded(rel)) continue;
      const st = statSync(child);
      if (st.isDirectory()) walk(child);
      else if (st.isFile()) entries.push({ path: rel, data: new Uint8Array(readFileSync(child)) });
    }
  };
  walk(dir);
  return entries;
}

type DropCreated = {
  drop_id: string;
  upload_url: string;
  upload_headers: Record<string, string>;
  status_url: string;
  max_upload_size_bytes: number;
};
type DropStatus = {
  status: string;
  url: string | null;
  error: { code?: string; message?: string } | null;
};

const DEPLOY_POLL_MS = 2500;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

async function cmdDeploy(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
): Promise<number> {
  const config = readConfig(deps.cwd);
  const tok = token(flags, deps);
  const dir = resolve(deps.cwd, str(flags.dir) ?? ".");

  const entries = collectDeployEntries(dir);
  if (!entries.some((e) => e.path === "index.html")) {
    throw new CliError(
      `No index.html at the root of ${dir} — deploy from your app's root (or pass --dir).`,
    );
  }
  const archive = createZip(entries);
  deps.log(`Packed ${entries.length} files (${(archive.length / 1024).toFixed(1)} KB). Creating drop…`);

  const createRes = await deps.fetch(`${config.apiUrl.replace(/\/$/, "")}/api/drops`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ project_id: config.projectId }),
  });
  const created = (await createRes.json().catch(() => null)) as DropCreated | { error?: string } | null;
  if (!createRes.ok || !created || !("upload_url" in created)) {
    throw new CliError(
      `Creating the drop failed: ${(created as { error?: string } | null)?.error ?? `HTTP ${createRes.status}`}`,
    );
  }
  if (archive.length > created.max_upload_size_bytes) {
    throw new CliError(
      `Archive is ${archive.length} bytes — over the ${created.max_upload_size_bytes}-byte limit.`,
    );
  }

  const putRes = await deps.fetch(created.upload_url, {
    method: "PUT",
    headers: created.upload_headers ?? { "Content-Type": "application/zip" },
    // createZip returns an exact-sized view, so its backing buffer IS the
    // archive; the cast bridges Uint8Array<ArrayBufferLike> vs BodyInit typing.
    body: archive.buffer as ArrayBuffer,
  });
  if (!putRes.ok) throw new CliError(`Uploading the archive failed: HTTP ${putRes.status}`);
  deps.log("Uploaded. Bool is building in the cloud…");

  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const statusRes = await deps.fetch(created.status_url);
    const status = (await statusRes.json().catch(() => null)) as DropStatus | null;
    if (!statusRes.ok || !status) throw new CliError(`Polling drop status failed: HTTP ${statusRes.status}`);
    if (status.status === "ready") {
      deps.log(`Live at ${status.url ?? config.appUrl}`);
      return 0;
    }
    if (status.status === "failed") {
      throw new CliError(
        `Deploy failed: ${status.error?.message ?? status.error?.code ?? "unknown error"}`,
      );
    }
    await deps.sleep(DEPLOY_POLL_MS);
  }
  throw new CliError("Timed out waiting for the deploy — check the project on Bool.");
}

const USAGE = `bool — develop locally against a Bool project, deploy to Bool

Usage:
  bool create <name> [--path <dir>] [--deploy] [--token <pat>]
                                           scaffold a new Bool todo app + project
  bool link --project <id> [--api-url <url>] [--token <pat>] [--types <path>]
  bool types [--out <path>] [--token <pat>]
  bool entities [--token <pat>]            list the project's data models
  bool entities pull [--token <pat>]       write schemas to ${ENTITIES_DIR}/
  bool entities push [--dir <path>]        declare local schemas on the project
  bool deploy [--dir <path>] [--token <pat>]

Auth: pass --token or set BOOL_TOKEN (Bool → Settings → Access tokens).
Data key: link writes BOOL_API_KEY to ${ENV_FILE} (owner only) — pass it to
createBoolClient as \`apiKey\`.`;

export async function runCli(argv: string[], overrides?: Partial<CliDeps>): Promise<number> {
  const deps: CliDeps = { ...defaults(), ...overrides };
  const { command, positionals, flags } = parseArgs(argv);
  try {
    switch (command) {
      case "create":
        return await cmdCreate(positionals, flags, deps);
      case "link":
        return await cmdLink(flags, deps);
      case "types":
        return await cmdTypes(flags, deps);
      case "entities":
        switch (positionals[0]) {
          case undefined:
            return await cmdEntities(flags, deps);
          case "push":
            return await cmdEntitiesPush(flags, deps);
          case "pull":
            return await cmdEntitiesPull(flags, deps);
          default:
            deps.error(`Unknown entities subcommand "${positionals[0]}".\n\n${USAGE}`);
            return 1;
        }
      case "deploy":
        return await cmdDeploy(flags, deps);
      case undefined:
      case "help":
      case "--help":
        deps.log(USAGE);
        return command ? 0 : 1;
      default:
        deps.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof CliError) {
      deps.error(err.message);
      return 1;
    }
    throw err;
  }
}
