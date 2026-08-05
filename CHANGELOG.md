# Changelog

## 0.3.1

- **Fixes every published app that uses a live view.** `0.3.0` shipped
  `"sideEffects": false`, which tells bundlers no module in the package does
  anything at import time. But `dist/react.js` exists precisely to *do*
  something — it registers the live-query implementation into the React-free
  core at module scope — and apps load it as a bare `import "bool-sdk/react"`
  with no bindings used. So Vite's production build deleted that import
  outright, and `bool.entities.<table>.useQuery()` threw *"needs the React entry
  loaded once per app"* on first render.

  Only published builds were affected. Vite dev doesn't tree-shake, so an app
  worked in the editor preview and broke the moment it was published — the worst
  possible shape for this bug.

  Fixed by listing the entry: `"sideEffects": ["./dist/react.js"]`. The core
  stays tree-shakeable; only the module whose job is to run is marked as such.
  Verified by building a real Vite app against both configurations and calling
  `useQuery` in the bundled output — `false` loses the registration, the list
  keeps it. A test now pins the field, and rejects a listed path that isn't a
  real export.

  No code changes. If you have an app on `0.3.0`, reinstall to pick this up.

## 0.3.0

**First stable release of the gateway SDK.** Everything the `0.2.0-next.*`
prereleases accumulated is now on `latest`, so `npm install bool-sdk` (no
`@next`) gets the full surface. Bool's v2 runtime ships to everyone on this
version; new apps depend on `^0.3.0` rather than the floating canary tag, so a
future prerelease can no longer reach an app that didn't ask for it.

What a stable install now includes:

- **`bool.entities.<table>`** — the data layer that replaced hand-written
  Supabase calls. One-shot promises (`list`, `filter`, `get`, `create`,
  `update`, `delete`, `bulkCreate`, `bulkUpdate`, `importEntities`) plus
  `updateMany(query, ops)` for conditional writes and `$inc` counters that are
  atomic in SQL, so two simultaneous callers can't lose each other's work.
- **`bool.entities.<table>.useQuery(...)`** — a live React view: loads, stays
  current as anyone else changes rows, applies your writes optimistically, and
  rolls them back if they fail. Merge-by-id, response ordering, and burst
  coalescing live in the store rather than in app code, which is what stopped
  rows popping in and out.
- **Private realtime.** Row changes ride the socket on wristband-gated topics
  minted per viewer by the gateway — an update reaches other viewers in one hop
  with no refetch, and there is no channel an anon key can eavesdrop on.
- **`bool.auth`** — the app's own end-user accounts (supabase-js-shaped:
  `signUp`, `signInWithPassword`, `signInWithOAuth`, `getUser`, password reset),
  with passwords hashed server-side and the session in an httpOnly cookie.
- **`bool.ai`** — text generation and JSON-Schema-validated structured output
  with no API key of your own; failures throw `BoolAiError` with a
  machine-readable `code`.
- **The `bool` CLI** — `create`, `link`, `types`, `entities push`, `deploy`, for
  developing against a real Bool from your own machine.

No API changes from `0.2.0-next.28`; this is that code, promoted. Apps already
pinned to the `next` tag keep resolving prereleases and are unaffected.

## 0.2.0-next.28

- **`bool.entities.<table>.useQuery(opts?)` — the live hook moves onto the
  entities dot-path**, the shape tRPC and InstantDB made conventional. One
  namespace for everything table-shaped, typed per-table by the generated
  `.d.ts` files, and an options typo (`{ srot: … }`) is now a build error via
  excess-property checking instead of the silent no-op a mistyped table *string*
  produced.

  Core stays React-free: the handler method delegates to an implementation that
  importing `bool-sdk/react` registers. Calling it without that import throws an
  error naming the fix and pointing non-React callers at `.list()`.
  `useEntity(table, opts)` still works — both spellings share one
  implementation.

  Live applies to what a *screen renders*, not to what endpoints exist: the
  one-shot promise methods are unchanged, because event handlers, the CLI, and
  the HTTP API all need non-live reads.

## 0.2.0-next.27

- **`bool help` / `bool --help` / bare `bool` now print a real trace of the
  bool logomark instead of a generic figlet font.** The wordmark is rasterized
  from the actual logo artwork and downsampled to quadrant block characters —
  same b bowl, same two o rings, same l — in the exact brand colors
  (blue/purple/teal/coral) from the web logo. On a TTY, the tri-color spark
  bursts open over three redrawn frames, the same flourish as the web logo's
  hover animation, without moving a single letter. Piped output, `NO_COLOR`,
  and non-interactive runs get one static print of the finished mark — no
  animation, no escape codes beyond color.

  Zero new dependencies: the art is precomputed offline from the SVG and
  baked into `cli.ts` as data, consistent with the CLI staying
  zero-dependency at runtime.

## 0.2.0-next.26

- **Removes the public-channel fallback entirely. Every doorbell topic is now
  wristband-gated.** The compat path existed to keep already-deployed bundles
  working, but it cost a second `realtime.messages` insert on every row change
  forever, left an anon-joinable topic whose only protection was schema-name
  obscurity, and had no retirement mechanism. Nothing real depended on it.

  Consequences, all improvements:
  - one broadcast per row change instead of two (halves write amplification)
  - no channel an anon key can eavesdrop on — a socket with no gateway-minted
    wristband hears nothing at all
  - the `id`-stripping workaround from `next.25` is gone with the channel that
    needed it

- **Failure is surfaced, not disguised.** With no degraded path to slink onto,
  the doorbell retries with capped backoff (1s → 5s → 15s → 60s, reset by a good
  join) and reports state via `doorbell.status()` / the `onStatus` dep:
  `connecting` | `live` | `unauthorized` | `unavailable`. HTTP reads keep working
  throughout, so an app is never broken — just not live, visibly.

- `mint()` now returns a discriminated `MintResult` so "the gateway refused you"
  (403) is distinguishable from "I couldn't reach the gateway" (network, 404,
  503). A public app admits every visitor, so a dropped request must never be
  presented to them as *unauthorized*.

  Public no-auth apps are the primary path and unaffected by the removal:
  verified on dev — an anonymous visitor mints (200), joins `bool:<schema>:app`,
  and receives full row payloads, while an anon-key eavesdropper on the old
  public topic hears nothing.

## 0.2.0-next.25

- **Fixes live updates being silently swallowed on the public fallback channel.**
  Supabase Realtime injects its own message-uuid `id` into any broadcast payload
  that lacks one. The public compat channel is row-data-free by contract, so its
  payloads have no row id — meaning subscribers received an `id` that looked
  exactly like a row id but wasn't. The live store would keyed-fetch a
  nonexistent row, apply nothing, and drop the change on the floor.

  The doorbell now strips legacy-channel payloads to `{table, op}` rather than
  trusting the transport's shape. Absent `id` is the signal that triggers a
  coalesced full reload, which is the correct behavior on a channel that carries
  no row data. Private-channel payloads are untouched — they keep `id` and `row`.

  Only reachable on the fallback paths (no mint desk, revoked access, refused
  join), which is also where it was hardest to notice.

## 0.2.0-next.24

- **Private realtime: live updates now arrive with the ROW on a private
  channel, in one socket hop.** The client half of the platform's private
  doorbell (codehs/bool#570; measured there: commit → observer ding ≈ 0–3ms,
  before the writer's own insert response returns).

  `subscribeToChanges` now mints a short-TTL "wristband" from the gateway
  (`POST /_bool/v1/realtime/token` — where liveAccess/session are re-checked on
  EVERY mint), presents it via `realtime.setAuth`, and joins the app's private
  topics: the app room, plus the personal room when signed in. It re-mints at
  ~75% of the TTL; a refused re-mint (access revoked, gateway down) silences
  the private rooms and degrades to the legacy public row-data-free ping — so
  does a missing wristband desk (older platform) or a refused join. Live-ness
  degrades, never dies. One doorbell is shared by all subscribers (previously
  every `entities.<table>.subscribe` opened its own channel).

- **Re-lands the live layer reverted in `0.2.0-next.23`** — `useEntity`
  (`bool-sdk/react`), `LiveEntityStore`, `matchesFilter`, `compareBySort`, the
  `id`/`row` payload fields, and the globalThis client registry — now on the
  architecture it was built for: a ding carrying `row` applies with ZERO
  fetches; only id-only dings (RLS-on tables without `owner_id`, legacy pings)
  keyed-fetch through the gateway.

- **Coalescing is now leading-edge.** A lone change reconciles immediately
  (the trailing window taxed every single change 50ms just in case a burst was
  coming); bursts still collapse into one pass per window.
## 0.2.0-next.20

- **Reverts the reload-hold behavior added in `0.2.0-next.19`.** That release
  withheld the doorbell reload while a client's own writes were in flight, to stop
  rows popping out and back in. It measurably reduced the flicker but did not fix
  it, so it isn't worth the complexity it carries.

  Two reasons it falls short. It bounds how long a ping can be held, so that
  continuous editing keeps seeing other people's changes — and past that bound a
  reload fires mid-flight and the flicker returns (reproduced at 2.6s under
  sustained writes). More fundamentally, it guards when a reload is *issued* but
  not when its result is *applied*: a reload already in flight still lands after
  the next optimistic row appears and replaces the list without it.

  Both are the same underlying thing — any design that replaces the whole list
  from a server snapshot has a window in which that snapshot is stale. The fix is
  to stop replacing the list (merge the changed row by id), not to keep shrinking
  the window.

  Preserved on the `preserve/realtime-reload-hold` branch.

## 0.2.0-next.19

- Rows no longer pop out and back in when you add several quickly. The doorbell
  says "something changed" without saying which row, so an app reloads its whole
  list on every ping — and a reload issued while the app's own inserts are still
  in flight comes back *without* them, replacing what's on screen with a snapshot
  missing rows the user already added. Measured on a live app: a row was absent
  for 200ms before reappearing. It's a lost-update race, not latency; an
  instantaneous network would still return a snapshot lacking uncommitted rows.

  The SDK now withholds the reload signal while this client's own writes are
  landing and fires once when they drain, plus a short trailing coalesce so a
  burst collapses into one reload (the trigger fires per changed *row*, so a bulk
  write produces N pings for one logical refresh). A ceiling bounds the hold so
  continuous local editing can't starve the app of other users' changes.

  **No app changes needed** — the existing `subscribe(() => load())` pattern
  simply stops flickering. Apps pick this up on their next publish.

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
