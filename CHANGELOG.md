# Changelog

## 0.2.0-next.18

- `bool create` now verifies the new project can be developed against *before*
  writing any files. A project that isn't on the gateway runtime can't be used
  as a local backend; previously `create` scaffolded the whole app and only then
  hit the error, leaving an orphaned folder. It now fails immediately with the
  server's reason and scaffolds nothing.
- The scaffolded app pins `bool-sdk@0.2.0-next.17` (the latest published
  release), catching the template pin up from `next.16`.

## 0.2.0-next.17

- `createBoolClient` routes the gateway same-origin for any deployment
  subdomain, not just the canonical one — fixes a 404 when a deployed app is
  reached via a renamed slug.

## 0.2.0-next.16

- `bool create` no longer requires a name — a bare `bool create` generates a
  friendly one (e.g. `swift-otter-42`) and scaffolds into a matching folder.
  Pass a name to override. Combined with the default API URL (or `BOOL_API_URL`),
  `bool create` alone stands up a new todo app + project.

## 0.2.0-next.15

- `bool create` now aborts (exit 1) if the entity push fails, instead of
  deploying an app whose data model was never created. It prints how to finish
  (`bool entities push` + `bool deploy`) once the cause is fixed.
- The scaffolded todo app shows the real error message instead of
  "[object Object]" — bool-sdk throws the raw (often non-Error) error, so the
  template now extracts `.message` from it.

## 0.2.0-next.14

- Fix `bool create`: the scaffolded app now lists `@supabase/supabase-js`
  (a bool-sdk peer dependency) in its `package.json`, so the deploy/cloud build
  can resolve it — previously `vite build` failed with "Rollup failed to resolve
  import @supabase/supabase-js". Verified with a real `npm install && vite build`.

  Note: `bool create` / `bool entities push` also need the platform's
  `POST /api/projects/[id]/entities` endpoint (added in codehs/bool#488). Without
  it the entity push returns HTTP 405.

## 0.2.0-next.13

- New `bool create <name> [--path <dir>] [--deploy]` — scaffold a new Bool
  project and a working todo-list app in one command. Creates the project
  (`POST /api/projects`), writes a self-contained Vite + React todo app wired to
  the project through `bool-sdk`, links it (`bool.config.json` + `.env.bool` +
  types), and declares a public `todos` entity so the deployed app works with no
  sign-in. `--deploy` publishes it immediately.

## 0.2.0-next.12

- CLI: fail with a clear message instead of crashing when the API returns a
  non-JSON `2xx` response. This happens when `--api-url` points at a host that
  serves the HTML app shell (e.g. the Bool API isn't deployed there yet) — the
  `link`, `entities`, and `entities pull` commands previously threw an
  unhandled `TypeError` (`Cannot read properties of null`). They now report
  `expected a JSON response … — check --api-url` and exit 1.

## 0.2.0-next.11

Local development: use a Bool project as a managed backend from your own
machine, and publish back to Bool — without leaving your editor.

- `createBoolClient({ ..., apiKey })` — a Bool data API key (`boolsk_` project
  admin key, or a `boolk_` end-user key) is sent as the `api_key` header on
  every gateway call (db, users, ai), so the client now works from anywhere:
  Node scripts, a local Vite app, CI. Without `apiKey`, behavior is unchanged.
- New CLI (`npx bool-sdk <command>`, zero dependencies):
  - `link --project <id>` — connects a local folder to a Bool project. Writes
    `bool.config.json` (public connection config), puts the project's admin
    data key in `.env.bool` (gitignored; owner only), and pulls entity types.
  - `types` — regenerates `bool/types.d.ts` from the project's entity schemas,
    so `bool.entities.<name>` is fully typed locally.
  - `entities` — prints the project's declared entities + fields.
  - `entities pull` / `entities push` — round-trip the entity schema files
    (`bool/entities/*.jsonc`) between the project and disk: pull writes them
    verbatim, push declares every local file on the project (additive
    migrations server-side; per-file results and warnings reported).
  - `deploy` — zips the app source (node_modules/.git/env files excluded) and
    publishes it on Bool via the drop pipeline: Bool builds in the cloud and
    the project URL stays stable.
  - Platform calls authenticate with a personal access token (`--token` or
    `BOOL_TOKEN`).

Requires the local-dev endpoints in the Bool platform repo
(`/api/projects/[id]/connection`, `/api/projects/[id]/entities/types`,
`POST /api/drops`).

## 0.2.0-next.10

Adds `bool.ai` — the AI battery. A deployed app can call a model with NO API key
in the bundle: the call routes through the gateway's AI plane (`/_bool/v1/ai`),
which runs the prompt against Bool's own provider credential and meters one AI
credit against the app owner's workspace. The key never reaches the client.

- `bool.ai.generate(prompt)` → `Promise<string>` — plain text.
- `bool.ai.generate({ prompt, schema })` → `Promise<T>` — structured output
  validated against a JSON Schema; returns the parsed, typed object.
- `bool.ai.stream(prompt)` → `AsyncIterable<string>` — text chunks for
  typewriter UIs.
- New exports: `BoolAi`, `BoolAiSchema`, and `BoolAiError` (carries `status` +
  machine-readable `code`, e.g. `"out_of_ai_credits"` on a 402).

Additive on the canary channel. The plane is gated server-side by the `bool-ai`
feature flag (off by default), so `bool.ai` only works where the workspace has
been opted in.

Requires the gateway AI plane in the Bool platform repo (`lib/gateway/ai-route.ts`).

## 0.2.0-next.9

Fix: `AuthGate` / `useSignInForm` no longer disagree about a pending
`?bool_reset_token=` link.

- Signing out after a password reset no longer bounces back to "set a new
  password" — the token is now stripped from the URL exactly once, at the
  provider, instead of lingering forever and being re-read on every
  unauthenticated remount.
- Clicking a reset link while already signed in (e.g. from a previous reset,
  which signs you in on the new password) now correctly prompts for a new
  password instead of silently auto-logging in — `AuthGate` forces the
  reset screen whenever a token is pending, even over an active session.

`src/react.tsx` was unchanged since `0.1.0`, so this bug shipped to every
already-created app on the stable `^0.1.0` range too.

## 0.2.0-next.8

Adds per-user API keys: the gateway's `/users/me` lazily
mints and returns a personal `api_key` for the signed-in end user.

- `BoolUser.apiKey?: string` — typed access to the key.
- `auth.rotateApiKey()` — rotates the key; the old one stops working
  immediately. Surfaces a 503 if keys aren't configured on the deployment.

External callers send the key as the `api_key` header and act exactly as
that user — same per-user RLS scoping as in the app. Pairs with a gateway-side
change that accepts `api_key` and stamps `sub` accordingly.

## 0.2.0-next.7

- **Entities pagination cap raised 1000 → 5000.** `list` and
  `filter` still page (50 rows by default) but now allow up to 5000 rows per
  call. A `limit` above the cap **throws** instead of silently truncating, so
  over-large reads fail loudly rather than returning a partial result the caller
  mistakes for the whole set. Page larger tables with `limit` + `skip`.

## 0.2.0-next.6

Combines the entities data layer (next.0–next.4) with the auth fail-safe fix
that shipped separately as next.5, so the canary `next` channel carries both.

Fix (from next.5): `onAuthStateChange` (and thus `<AuthGate>`) no longer hangs
forever when the initial `/users/me` session check rejects (cross-origin/network
failure — e.g. the sandbox-preview context used for project-card screenshots). A
rejected check now fires `SIGNED_OUT` instead of leaving `loading` stuck, so the
app renders its sign-in screen rather than a blank page. Adds a regression test.

## 0.2.0

Adds the **entities data layer** — a high-level data API over the gateway so
apps read/write data without touching Supabase, SQL, or credentials directly:

```ts
const todos = await bool.entities.todos.list("-created_at");
const one   = await bool.entities.todos.create({ title: "hi" });
await bool.entities.todos.update(one.id, { done: true });
await bool.entities.todos.filter({ status: "active", count: { $gte: 10 } });
```

`bool.entities.<table>` exposes the full entity surface:
- **Reads:** `list`, `filter`, `get` — with `sort` (`-col`), `limit`, `skip`,
  and `fields` (column selection).
- **Writes:** `create`, `bulkCreate`, `update`, `bulkUpdate`, `delete`.
- **Bulk-by-query:** `updateMany(query, { $set })`, `deleteMany(query)`.
- **Import:** `importEntities(csvFile)` (parsed client-side → `bulkCreate`).
- **Realtime:** `subscribe(cb)` (gateway doorbell).
- **Filter DSL:** MongoDB-style — `$eq $ne $gt $gte $lt $lte $in $nin $exists
  $regex $all $not` per field, `$and`/`$or`/`$nor` at the root, array shorthand,
  and `null` → IS NULL.

Methods return row data directly and throw on error. Additive and
backward-compatible — `bool.db` / `supabase` still work.

Known gaps (documented, follow-ups): `updateMany` with
`$inc/$mul/$push/$pull` is read-modify-write (not atomic under concurrent
writers — a Postgres RPC would make it atomic); `$size` (filter by array
length) isn't expressible over PostgREST and is omitted.

**`EntitiesModule` is now an augmentable `interface`** (was a `type` alias), so
generated apps can type each entity via `declare module "bool-sdk"`:

```ts
declare module "bool-sdk" {
  interface EntitiesModule { board_games: EntityHandler<BoardGames> }
}
```

That makes `bool.entities.board_games` typed (field names, enum values, types)
while the string index signature keeps un-declared tables usable as
`EntityHandler<any>`. Bool's `define_entity` tool writes one such `.d.ts` per
model. No runtime change.

## 0.1.1

Publishing now goes through npm OIDC trusted publishing (no long-lived token).
No functional or API changes.

## 0.1.0

Initial release. Lifts the previously-vendored Bool v2 ("gateway") app client
out of per-app scaffold files into a published package:

- `createBoolClient(config)` — supabase-js client routed through the Bool
  gateway data plane (REST + Storage), realtime doorbell helper
  (`subscribeToChanges`), and the end-user auth surface (`client.auth`)
  against the gateway users plane.
- `bool-sdk/react` — `BoolAuthProvider`, `useBoolAuth`, `AuthGate`,
  `useSignInForm`.
