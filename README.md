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
- **Realtime "doorbell".** Postgres changes broadcast a row-data-free
  `{table, op}` ping on the app's public channel; `subscribeToChanges` wraps
  the subscription. Refetch on each ping — the ping never carries row data.
- **End-user auth.** `client.auth` mirrors the `supabase.auth` surface
  (`signUp`, `signInWithPassword`, `signInWithOAuth`, `signOut`, `getUser`,
  `onAuthStateChange`, password reset) but talks to the Bool gateway's users
  plane, so each app has its own isolated accounts and the client never
  handles a credential.
- **AI battery.** `client.ai` gives a deployed app server-side AI with **no API
  key in the bundle** — calls route through the gateway's AI plane
  (`/_bool/v1/ai`), which runs the prompt against Bool's provider credential and
  meters the app owner's app-credit pool. Returns results directly and throws
  a `BoolAiError` (with `status` + `code`, e.g. `"out_of_app_credits"`) on failure:
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
- **Email battery.** `client.email` lets a deployed app send email with **no SMTP
  config and no API key** — calls route through the gateway's email plane
  (`/_bool/v1/email`), which renders the message, meters the same app-credit pool
  as `bool.ai`, and queues it in a durable outbox (so a resolved `send` will keep
  retrying delivery server-side).
  ```ts
  await bool.email.send({
    to: "owner",                    // the person who built this app
    subject: "New contact form submission",
    body: `From: ${name}\n\n${message}`,          // plain text; blank lines = paragraphs
    button: { label: "Open the app", url: appUrl }, // optional, https only
    replyTo: "owner",                              // optional
  });
  ```
  **Who you can email is enforced server-side**, and it's a short list: the app's
  **owner** (pass the literal `"owner"`, so their address never ships in the
  bundle) or a signed-in **end user of this app who has verified their address**.
  An address a visitor merely typed into a form is refused with
  `recipient_not_allowed`. That's deliberate — an app that could email anyone
  would turn Bool's sending domain into a spam relay, and every other app's mail
  would pay for it.

  There is no HTML body, no attachments and no custom `from`: app-authored markup
  sent from a Bool-signed domain would be a ready-made phishing kit, so every
  message renders into one fixed template carrying the app's name.

  Throws a `BoolEmailError` (`status`, `code`, and `detail` — the gateway's
  human-readable explanation) on failure. Two non-failures resolve normally:
  `{ duplicate: true }` when an `idempotencyKey` matched an existing send, and
  `{ suppressed: true }` when the address is on the platform's do-not-mail list
  (it previously hard-bounced or reported spam). Requires the workspace to be
  opted into the `bool-email` server flag.
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
React layer picks up — pass `client={...}` to `<BoolAuthProvider>` only if you
create more than one.

## Compatibility

The gateway wire paths (`/_bool/v1/db`, `/_bool/v1/users`, `/_bool/v1/ai`) are
append-only: new server behavior ships under a new path/version segment, never
by mutating what existing SDK versions call. Keep this SDK in sync with the
gateway routes in the Bool platform repo (`lib/gateway/`).

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
