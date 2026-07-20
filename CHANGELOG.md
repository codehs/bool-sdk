# Changelog

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

Adds per-user API keys (Base44 convention): the gateway's `/users/me` lazily
mints and returns a personal `api_key` for the signed-in end user.

- `BoolUser.apiKey?: string` — typed access to the key.
- `auth.rotateApiKey()` — rotates the key; the old one stops working
  immediately. Surfaces a 503 if keys aren't configured on the deployment.

External callers send the key as the `api_key` header and act exactly as
that user — same per-user RLS scoping as in the app. Pairs with a gateway-side
change that accepts `api_key` and stamps `sub` accordingly.

## 0.2.0-next.7

- **Entities pagination cap raised 1000 → 5000, matching Base44.** `list` and
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

Adds the **entities data layer** — a Base44-parity data API over the gateway so
apps read/write data without touching Supabase, SQL, or credentials directly:

```ts
const todos = await bool.entities.todos.list("-created_at");
const one   = await bool.entities.todos.create({ title: "hi" });
await bool.entities.todos.update(one.id, { done: true });
await bool.entities.todos.filter({ status: "active", count: { $gte: 10 } });
```

`bool.entities.<table>` mirrors Base44's entity surface one-to-one:
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

Known gaps vs. Base44 (documented, follow-ups): `updateMany` with
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
