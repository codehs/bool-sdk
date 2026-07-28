# bool-sdk

The client SDK for apps built on [Bool](https://bool.com). Every Bool app
("Bool") gets this pre-wired — it's how the app reaches its data, files, and
end-user accounts through the Bool gateway.

**If you're building an app on Bool you don't install or configure this
yourself.** Your app already has it: import from `@/lib/supabase` and
`@/lib/bool-auth` as usual. This repo exists so the plumbing is versioned,
tested, and upgradable independently of any one app.

## What it does

- **Entities data API.** `client.entities.<table>` is the recommended way to
  read/write data — a simple, high-level entity surface: `list`,
  `filter`, `get`, `create`, `bulkCreate`, `update`, `bulkUpdate`, `updateMany`,
  `delete`, `deleteMany`, `importEntities`, `subscribe`. It hides Supabase/SQL
  entirely; methods return rows directly and throw on error:
  ```ts
  const todos = await bool.entities.todos.list("-created_at");
  const one   = await bool.entities.todos.create({ title: "hi" });
  await bool.entities.todos.update(one.id, { done: true });
  await bool.entities.todos.filter({ status: "active", count: { $gte: 10 } });
  await bool.entities.todos.updateMany({ done: false }, { $set: { done: true } });
  ```
  Filters use MongoDB-style operators (`$eq $ne $gt $gte $lt $lte $in $nin
  $exists $regex $all $not`, plus `$and`/`$or`/`$nor`); sort is a `-col` string.
  `list`/`filter` are paged: **50 rows by default, 5000 max per call** (over-cap
  throws) — page larger tables with the `limit` + `skip` args. `updateMany` /
  `deleteMany` act on every matching row regardless of page size.
- **Data + Storage through the Bool gateway.** `client.db` is a standard
  [supabase-js](https://supabase.com/docs/reference/javascript) client (what
  `entities` is built on) whose REST and Storage traffic is routed to the Bool
  gateway (`/_bool/v1/db`). The gateway injects the real credential server-side
  and pins the app's private Postgres schema — the anon key in the bundle has
  no data grants and can't read anything directly.
- **Live data.** `useEntity` (from `bool-sdk/react`) gives a screen rows that
  stay current, with optimistic writes:

  ```tsx
  import { useEntity } from "bool-sdk/react";

  const todos = useEntity("todos", { sort: "-created_at" });
  todos.data;                              // live rows
  await todos.create({ title });           // appears instantly, rolls back on failure
  await todos.update(id, { done: true });
  await todos.remove(id);
  ```

  Under it: a Postgres trigger broadcasts each change — **with the row** — on a
  **private** channel that only a short-TTL token minted by the Bool gateway can
  join, so an update reaches other viewers in one socket hop with no refetch.
  Writes and first loads still go through the gateway (that's where
  authorization and metering live). `subscribeToChanges` is the low-level
  primitive underneath; prefer `useEntity`.

  "Private" here means **token-gated, not login-gated** — a public app with no
  accounts gets a token for every visitor. When an app *does* have end users,
  per-user rows additionally ride that user's own private channel.

  If a token can't be obtained (not authorized for this app, or the gateway is
  unreachable) the doorbell retries with backoff and reports state rather than
  degrading silently — data still loads over HTTP, it just isn't live.
- **End-user auth.** `client.auth` mirrors the `supabase.auth` surface
  (`signUp`, `signInWithPassword`, `signInWithOAuth`, `signOut`, `getUser`,
  `onAuthStateChange`, password reset) but talks to the Bool gateway's users
  plane, so each app has its own isolated accounts and the client never
  handles a credential.
- **AI battery.** `client.ai` gives a deployed app server-side AI with **no API
  key in the bundle** — calls route through the gateway's AI plane
  (`/_bool/v1/ai`), which runs the prompt against Bool's provider credential and
  meters one AI credit against the app owner. Returns results directly and throws
  a `BoolAiError` (with `status` + `code`, e.g. `"out_of_ai_credits"`) on failure:
  ```ts
  const text = await bool.ai.generate("Summarize this review: " + review);

  const { sentiment, topics } = await bool.ai.generate<{
    sentiment: string; topics: string[];
  }>({
    prompt: review,
    schema: {
      type: "object",
      properties: { sentiment: { type: "string" }, topics: { type: "array", items: { type: "string" } } },
      required: ["sentiment", "topics"],
    },
  });

  for await (const chunk of bool.ai.stream("Write a haiku")) setText((t) => t + chunk);
  ```
  Requires the workspace to be opted into the `bool-ai` server flag.
- **React auth layer** (`bool-sdk/react`): `<BoolAuthProvider>`,
  `useBoolAuth()`, `<AuthGate>`, and the headless `useSignInForm()` state
  machine that login forms bind to.

## Local Development (Your Own Machine)

Build an app on your computer, use a Bool project as your backend, then
publish to `https://<slug>.bool.so`. This is the one case where you install
the SDK yourself.

### Quick Start

```bash
npm install bool-sdk
export BOOL_TOKEN=bool_live_xxxxx  # from Bool → Settings → Access tokens

npx bool link --project <id>       # connect to a Bool project
npx bool entities push --dir bool/entities  # push schema changes
npx bool deploy                    # publish when ready
```

**Three new files after `link`:**
- `bool.config.json` — project metadata (commit this)
- `.env.bool` — admin key (gitignore, keep secret)
- `bool/types.d.ts` — TypeScript types (auto-updated)

**Then in your app:**

```ts
import { createBoolClient } from "bool-sdk";
import config from "./bool.config.json";

export const bool = createBoolClient({
  supabaseUrl: config.supabaseUrl,
  supabaseAnonKey: config.supabaseAnonKey,
  schema: config.schema,
  appOrigin: config.appOrigin,
  slug: config.slug,
  apiKey: process.env.BOOL_API_KEY, // from .env.bool
});

// Now use your data
const todos = await bool.entities.todos.list();
```

### Documentation

Complete guides at **[bool.com/docs](https://bool.com/docs)**:

- **[Develop locally (CLI)](https://bool.com/docs/cli)** — the CLI commands, the
  local workflow, client setup, and deploying
- **[Database](https://bool.com/docs/database)** — entities, records, and your
  data model

### Admin Key Gotcha

When using the admin key (`apiKey`), on a **private** entity (one Bool gives an
`owner_id` owner column), you must set `owner_id` explicitly:

```ts
// ❌ Fails on private entity (owner_id has no value to default to)
await bool.entities.tasks.create({ title: "Task" });

// ✅ Works
await bool.entities.tasks.create({ title: "Task", owner_id: userId });
```

The admin key has no user identity, so it can't default `owner_id`. End-user
clients and `boolk_` keys carry the user and default it automatically.

Coding agents can do all of the above through Bool's MCP server instead
(`list_entities`, `define_entity`, `list_records`, `get_entity_types`,
`get_project_connection`, …) — see the platform docs.

## Usage

```ts
// Bool apps ship this in src/lib/supabase.ts:
import { createBoolClient } from "bool-sdk";

export const bool = createBoolClient({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL!,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY!,
  schema: import.meta.env.VITE_BOOL_DB_SCHEMA!,
  appHost: import.meta.env.VITE_BOOL_APP_HOST,
  appOrigin: import.meta.env.VITE_BOOL_APP_ORIGIN,
  slug: import.meta.env.VITE_BOOL_SLUG,
  viewerToken: import.meta.env.VITE_BOOL_VIEWER_TOKEN,
});

export const supabase = bool.db; // use like any supabase-js client
export const auth = bool.auth;   // this app's own end-user accounts
```

```tsx
// React auth (the default client is the one created above):
import { BoolAuthProvider, AuthGate, useBoolAuth, useSignInForm } from "bool-sdk/react";

<BoolAuthProvider>
  <AuthGate fallback={<SignInForm />}>
    <App />
  </AuthGate>
</BoolAuthProvider>;
```

`createBoolClient` registers the client it returns as the default, which the
React layer and `useEntity` pick up — pass `client={...}` only if you create
more than one.

> **Keep `import "./lib/supabase"` in `src/main.tsx`.** That module calls
> `createBoolClient`, and hooks find the client from that registration. Under
> `useEntity` no file mentions `@/lib/supabase` by name, so the import looks
> unused — deleting it makes every screen throw *"No Bool client exists yet"* on
> first render.

### Live data notes

- **Render `todos.data` directly.** Don't copy it into another `useState` and
  sync them; the duplicate is what goes stale.
- **Don't add your own optimistic state.** `create`/`update`/`remove` already
  apply immediately and roll back on failure. They don't throw — they resolve to
  the new row (or `true`), or `null`/`false` with the reason on `error`.
- **High-frequency input must be batched.** Drawing strokes, drag positions,
  sliders: buffer locally and persist **once per gesture** (pointer-up, blur,
  debounce), e.g. one row holding a points array. A write per input event is
  ~60 requests/second.
- **Filters and sorts** use the same DSL as `entities`:
  `useEntity("todos", { filter: { done: false }, sort: "title", limit: 100 })`.
  A filtered view self-maintains — rows that stop matching leave, rows that start
  matching arrive.
- **`postgres_changes` does not work** on gateway-era apps (the app's schema has
  no direct grants). `useEntity` is the way to react to changes.

## Compatibility

The gateway wire paths (`/_bool/v1/db`, `/_bool/v1/users`, `/_bool/v1/ai`,
`/_bool/v1/realtime`) are append-only: new server behavior ships under a new
path/version segment, never by mutating what existing SDK versions call. Keep
this SDK in sync with the gateway routes in the Bool platform repo
(`lib/gateway/`).

Realtime specifically pairs with the platform's doorbell trigger and its
`realtime.messages` policy. The platform-side architecture, the history behind
it, and the failure modes to avoid are documented in the platform repo at
`docs/2026-07-realtime.md` — read that before changing anything in
`src/realtime.ts` or `src/live.ts`.

## Development

```sh
bun install
bun test          # behavioral tests (fetch/sessionStorage stubbed)
bun run typecheck
bun run build     # emits dist/ (ESM + .d.ts)
```

## Releasing

1. Bump `version` in `package.json` (semver — Bool app scaffolds depend on a
   caret range, so a **breaking change requires a major bump**).
2. Update `CHANGELOG.md`.
3. Merge to `main`, then create a GitHub release with tag `vX.Y.Z`.
4. The `Publish` workflow tests, builds, and publishes to npm (requires the
   `NPM_TOKEN` repo secret).

Because generated apps install from a caret range on every sandbox boot,
patch/minor releases reach existing apps automatically — that's the point,
and it's also why semver discipline here is load-bearing.
