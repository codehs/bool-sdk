# Changelog

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
