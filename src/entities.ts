// The Bool entities layer: a Base44-style data API over the gateway-routed
// Supabase client. App code (and the AI that writes it) works with
// `bool.entities.<table>` instead of raw `supabase.from(...)`, so a generated
// app never mentions Supabase, SQL, PostgREST, or credentials — the whole
// backend is invisible plumbing inside this package.
//
//   const todos = await bool.entities.todos.list("-created_at");
//   const one   = await bool.entities.todos.create({ title: "hi" });
//   await bool.entities.todos.update(one.id, { done: true });
//   await bool.entities.todos.filter({ status: "active", count: { $gte: 10 } });
//
// The method surface and filter DSL mirror Base44's entities module one-to-one
// (MongoDB-style `$`-operators, `-col` sort, bulk + *Many ops), so there's no
// need to drop down to raw SQL. Methods return row data directly and THROW on
// error (unlike supabase-js's `{ data, error }`), so app code reads clean.
import type { BoolChangePayload, BoolDb } from "./client.js";

/** Sort by a column, `-col` for descending (`+col`/`col` ascending).
 * Entity tables always have `created_at`, so it's the default. */
export type SortSpec = string;

/** MongoDB-style comparison operators for a single field. Mirrors Base44. */
export type FilterOperators = Partial<{
  $eq: unknown;
  $ne: unknown;
  $gt: unknown;
  $gte: unknown;
  $lt: unknown;
  $lte: unknown;
  $in: unknown[];
  $nin: unknown[];
  $exists: boolean;
  /** POSIX regex (maps to PostgREST `match`/`~`). */
  $regex: string;
  /** Array column contains all of these values. */
  $all: unknown[];
  /** Negate a single inner operator, e.g. `{ $not: { $eq: 5 } }`. */
  $not: Partial<
    Record<"$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte" | "$in" | "$regex", unknown>
  >;
}>;

/**
 * A filter query. Each key is a column; the value is:
 *   - a scalar → exact match (`{ status: "active" }`)
 *   - `null` → IS NULL (`{ archived_at: null }`)
 *   - an array → matches any of (`{ id: ["a", "b"] }`, i.e. `$in` shorthand)
 *   - an operator object → `{ count: { $gte: 100 } }`
 * Root-level `$and`/`$or`/`$nor` combine sub-queries.
 */
export type FilterValue =
  | string
  | number
  | boolean
  | null
  | Array<string | number | boolean>
  | FilterOperators;
export type FilterQuery = {
  [column: string]: FilterValue | FilterQuery[] | undefined;
  $and?: FilterQuery[];
  $or?: FilterQuery[];
  $nor?: FilterQuery[];
};

/** MongoDB-style update operators. `$set` is applied as one atomic PATCH; the
 * others (`$inc`/`$mul`/`$push`/`$pull`/`$unset`) are applied read-modify-write
 * (see updateMany docs — not atomic under concurrent writers). */
export type UpdateOps = Partial<{
  $set: Record<string, unknown>;
  $inc: Record<string, number>;
  $mul: Record<string, number>;
  $push: Record<string, unknown>;
  $pull: Record<string, unknown>;
  $unset: Record<string, true>;
}>;

export type DeleteResult = { success: boolean };
export type DeleteManyResult = { success: boolean; deleted: number };
export type UpdateManyResult = { success: boolean; updated: number; has_more: boolean };
export type ImportResult<T = any> = {
  status: "success" | "error";
  details: string | null;
  output: T[] | null;
};

/** CRUD + realtime for one entity table. `T` defaults to `any` (untyped);
 * apps can pass a row type for autocomplete. Mirrors Base44's EntityHandler. */
export interface EntityHandler<T = any> {
  /** All rows, newest first by default. `limit` defaults to 50, max 1000.
   * `fields` restricts the columns returned. */
  list(sort?: SortSpec, limit?: number, skip?: number, fields?: (keyof T & string)[]): Promise<T[]>;
  /** Rows matching `query`. See {@link FilterQuery}. */
  filter(
    query: FilterQuery,
    sort?: SortSpec,
    limit?: number,
    skip?: number,
    fields?: (keyof T & string)[],
  ): Promise<T[]>;
  /** One row by id. Throws if it doesn't exist. */
  get(id: string): Promise<T>;
  /** Insert a row; returns the created row (with server-filled id/created_at). */
  create(values: Partial<T>): Promise<T>;
  /** Insert many rows in one request; returns the created rows. */
  bulkCreate(values: Partial<T>[]): Promise<T[]>;
  /** Patch a row by id; returns the updated row. */
  update(id: string, values: Partial<T>): Promise<T>;
  /** Update many specific rows, each by its own `id`; returns the updated rows. */
  bulkUpdate(values: (Partial<T> & { id: string })[]): Promise<T[]>;
  /** Apply the same update to every row matching `query`. Pass Mongo-style
   * update operators (`{ $set: {...} }`) or a plain object (treated as `$set`). */
  updateMany(query: FilterQuery, ops: UpdateOps | Partial<T>): Promise<UpdateManyResult>;
  /** Delete a row by id. */
  delete(id: string): Promise<DeleteResult>;
  /** Delete every row matching `query`. */
  deleteMany(query: FilterQuery): Promise<DeleteManyResult>;
  /** Import rows from a CSV File (parsed client-side, then bulk-created). */
  importEntities(file: File): Promise<ImportResult<T>>;
  /** Fire `cb` whenever any row in THIS table changes (refetch on each ping —
   * the payload carries no row data). Returns an unsubscribe function. */
  subscribe(cb: (change: BoolChangePayload) => void): () => void;
}

/**
 * Dynamic map: `entities.<anyTableName>` yields a handler for that table.
 *
 * Declared as an `interface` (not a `type` alias) so a generated app can
 * AUGMENT it with typed per-entity members via `declare module "bool-sdk"`.
 * Bool's `define_entity` tool writes one `bool/entities/<name>.d.ts` per model
 * that does exactly that, e.g.:
 *
 *   declare module "bool-sdk" {
 *     interface EntitiesModule { board_games: EntityHandler<BoardGames> }
 *   }
 *
 * so `bool.entities.board_games.create({...})` is typed and typos are caught at
 * build time (`tsc -b`). The string index signature keeps every table — including
 * ones not yet declared — usable as `EntityHandler<any>` by default, so the
 * un-augmented SDK still works. A named member must be assignable to the index
 * signature, which `EntityHandler<Row>` (→ `EntityHandler<any>`) always is.
 */
export interface EntitiesModule {
  [table: string]: EntityHandler;
}

const DEFAULT_SORT = "-created_at";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

// A supabase-js filter/query builder is chainable and thenable; we only need
// the handful of methods below, so keep it loosely typed rather than importing
// supabase-js's internal builder generics.
type QueryBuilder = any;

const MONGO_TO_PG: Record<string, string> = {
  $eq: "eq",
  $ne: "neq",
  $gt: "gt",
  $gte: "gte",
  $lt: "lt",
  $lte: "lte",
  $in: "in",
  $regex: "match",
};

/** Map a Mongo comparison operator to the supabase-js builder call. */
function applyOperator(q: QueryBuilder, column: string, op: string, value: unknown): QueryBuilder {
  switch (op) {
    case "$eq":
      return value === null ? q.is(column, null) : q.eq(column, value);
    case "$ne":
      return value === null ? q.not(column, "is", null) : q.neq(column, value);
    case "$gt":
      return q.gt(column, value);
    case "$gte":
      return q.gte(column, value);
    case "$lt":
      return q.lt(column, value);
    case "$lte":
      return q.lte(column, value);
    case "$in":
      return q.in(column, value as unknown[]);
    case "$nin":
      return q.not(column, "in", `(${(value as unknown[]).join(",")})`);
    case "$exists":
      return value ? q.not(column, "is", null) : q.is(column, null);
    case "$regex":
      // PostgREST `match` operator (~). Supabase supports it.
      return q.filter(column, "match", value);
    case "$all":
      return q.contains(column, value as unknown[]);
    case "$not": {
      // Single inner operator, e.g. { $not: { $eq: 5 } }.
      const [innerOp, innerVal] = Object.entries(value as Record<string, unknown>)[0] ?? [];
      const pg = MONGO_TO_PG[innerOp as string];
      if (pg) return q.not(column, pg, innerVal);
      return q;
    }
    default:
      return q; // unsupported operator ($size) — silently ignored (documented)
  }
}

/** Serialize a flat sub-query to a PostgREST `or()` condition string, e.g.
 * `{ status: "active", count: { $gte: 3 } }` → `status.eq.active,count.gte.3`.
 * Only scalar equality + comparison operators are supported inside $or/$nor. */
function toPgConditions(query: FilterQuery): string {
  const parts: string[] = [];
  for (const [column, value] of Object.entries(query)) {
    if (column === "$and" || column === "$or" || column === "$nor") continue;
    if (value === null) parts.push(`${column}.is.null`);
    else if (Array.isArray(value)) parts.push(`${column}.in.(${(value as unknown[]).join(",")})`);
    else if (typeof value === "object") {
      for (const [op, v] of Object.entries(value as Record<string, unknown>)) {
        const pg = MONGO_TO_PG[op];
        if (pg) parts.push(`${column}.${pg}.${v}`);
      }
    } else {
      parts.push(`${column}.eq.${value}`);
    }
  }
  return parts.join(",");
}

/** Apply the negation of a flat sub-query (used for `$nor`): every condition
 * becomes its NOT, and the results AND together. Only scalar/comparison
 * conditions are supported inside `$nor`. */
function applyNegated(query: QueryBuilder, sub: FilterQuery): QueryBuilder {
  let q = query;
  for (const [col, cond] of Object.entries(sub)) {
    if (col === "$and" || col === "$or" || col === "$nor") continue;
    if (cond === null) q = q.not(col, "is", null);
    else if (Array.isArray(cond)) q = q.not(col, "in", `(${(cond as unknown[]).join(",")})`);
    else if (typeof cond === "object") {
      for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
        const pg = MONGO_TO_PG[op];
        if (pg) q = q.not(col, pg, v);
      }
    } else {
      q = q.not(col, "eq", cond);
    }
  }
  return q;
}

function applyFilter(query: QueryBuilder, filter: FilterQuery): QueryBuilder {
  let q = query;
  for (const [column, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (column === "$and") {
      for (const sub of value as FilterQuery[]) q = applyFilter(q, sub);
    } else if (column === "$or") {
      q = q.or((value as FilterQuery[]).map(toPgConditions).join(","));
    } else if (column === "$nor") {
      // NOR = AND of negated conditions (De Morgan). `.not("or", …)` isn't a
      // valid supabase-js call, so negate each sub-condition individually.
      for (const sub of value as FilterQuery[]) q = applyNegated(q, sub);
    } else if (value === null) {
      q = q.is(column, null);
    } else if (Array.isArray(value)) {
      q = q.in(column, value as unknown[]);
    } else if (typeof value === "object") {
      for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
        if (operand === undefined) continue;
        q = applyOperator(q, column, op, operand);
      }
    } else {
      q = q.eq(column, value);
    }
  }
  return q;
}

function applySort(query: QueryBuilder, sort: SortSpec): QueryBuilder {
  const ascending = !sort.startsWith("-");
  const column = sort.replace(/^[-+]/, "");
  return query.order(column, { ascending });
}

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes, and
 * embedded commas/newlines. Good enough for `importEntities`; swap for a full
 * parser if apps need exotic dialects. */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const header = rows[0]!;
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h] = r[i] ?? "";
    });
    return obj;
  });
}

function applyUpdateOps(row: Record<string, any>, ops: UpdateOps): void {
  if (ops.$set) Object.assign(row, ops.$set);
  if (ops.$inc) for (const [k, v] of Object.entries(ops.$inc)) row[k] = (row[k] ?? 0) + v;
  if (ops.$mul) for (const [k, v] of Object.entries(ops.$mul)) row[k] = (row[k] ?? 0) * v;
  if (ops.$push) for (const [k, v] of Object.entries(ops.$push)) row[k] = [...(row[k] ?? []), v];
  if (ops.$pull)
    for (const [k, v] of Object.entries(ops.$pull))
      row[k] = (row[k] ?? []).filter((x: unknown) => x !== v);
  if (ops.$unset) for (const k of Object.keys(ops.$unset)) row[k] = null;
}

const UPDATE_OP_KEYS = ["$set", "$inc", "$mul", "$push", "$pull", "$unset"];
function isUpdateOps(ops: Record<string, unknown>): ops is UpdateOps {
  return Object.keys(ops).some((k) => UPDATE_OP_KEYS.includes(k));
}

function createEntityHandler(
  db: BoolDb,
  subscribeToChanges: (listener: (p: BoolChangePayload) => void) => () => void,
  table: string,
): EntityHandler {
  function select(fields?: string[]): string {
    return fields && fields.length ? fields.join(",") : "*";
  }
  function paginate(query: QueryBuilder, limit: number, skip: number): QueryBuilder {
    const capped = Math.min(limit, MAX_LIMIT);
    return query.range(skip, skip + capped - 1);
  }
  async function unwrap<R>(query: QueryBuilder): Promise<R> {
    const { data, error } = await query;
    if (error) throw error;
    return data as R;
  }

  const handler: EntityHandler = {
    async list(sort = DEFAULT_SORT, limit = DEFAULT_LIMIT, skip = 0, fields) {
      return (
        (await unwrap<any[]>(
          paginate(applySort(db.from(table).select(select(fields)), sort), limit, skip),
        )) ?? []
      );
    },
    async filter(filter, sort = DEFAULT_SORT, limit = DEFAULT_LIMIT, skip = 0, fields) {
      return (
        (await unwrap<any[]>(
          paginate(
            applySort(applyFilter(db.from(table).select(select(fields)), filter), sort),
            limit,
            skip,
          ),
        )) ?? []
      );
    },
    async get(id) {
      return unwrap(db.from(table).select("*").eq("id", id).single());
    },
    async create(values) {
      return unwrap(db.from(table).insert(values).select().single());
    },
    async bulkCreate(values) {
      return (await unwrap<any[]>(db.from(table).insert(values).select())) ?? [];
    },
    async update(id, values) {
      return unwrap(db.from(table).update(values).eq("id", id).select().single());
    },
    async bulkUpdate(values) {
      // Upsert on the primary key: each row must include `id`.
      return (await unwrap<any[]>(db.from(table).upsert(values).select())) ?? [];
    },
    async updateMany(query, ops) {
      const n: UpdateOps = isUpdateOps(ops as Record<string, unknown>)
        ? (ops as UpdateOps)
        : { $set: ops as Record<string, unknown> };
      // $set + $unset are absolute assignments → one atomic PATCH.
      const setPart: Record<string, unknown> = { ...(n.$set ?? {}) };
      if (n.$unset) for (const k of Object.keys(n.$unset)) setPart[k] = null;
      const hasNumeric = !!(n.$inc || n.$mul);
      const hasArray = !!(n.$push || n.$pull);

      // Array operators can't be expressed atomically over PostgREST →
      // read-modify-write everything. Documented as non-atomic.
      if (hasArray) {
        const rows = (await unwrap<any[]>(applyFilter(db.from(table).select("*"), query))) ?? [];
        for (const row of rows) applyUpdateOps(row, n);
        if (rows.length) await unwrap(db.from(table).upsert(rows).select("id"));
        return { success: true, updated: rows.length, has_more: false };
      }

      // No arithmetic → a single atomic PATCH covers $set/$unset.
      if (!hasNumeric) {
        const rows =
          (await unwrap<any[]>(applyFilter(db.from(table).update(setPart), query).select("id"))) ?? [];
        return { success: true, updated: rows.length, has_more: false };
      }

      // Arithmetic ($inc/$mul) → ATOMIC via the per-schema `bool_apply_numeric`
      // function (the increment happens in SQL: `col = col + n`). Select the
      // target ids first (reusing the filter), apply any $set/$unset as a PATCH,
      // then call the function. Falls back to read-modify-write when the
      // function isn't provisioned on this schema (PGRST202), so it stays
      // correct on older schemas — just non-atomic there.
      const targets = (await unwrap<any[]>(applyFilter(db.from(table).select("id"), query))) ?? [];
      const ids = targets.map((r) => String(r.id));
      if (Object.keys(setPart).length && ids.length) {
        await unwrap(db.from(table).update(setPart).in("id", ids).select("id"));
      }
      if (ids.length) {
        const { error } = await db.rpc("bool_apply_numeric", {
          p_table: table,
          p_ids: ids,
          p_inc: n.$inc ?? null,
          p_mul: n.$mul ?? null,
        });
        if (error) {
          if ((error as { code?: string }).code === "PGRST202") {
            const rows = (await unwrap<any[]>(db.from(table).select("*").in("id", ids))) ?? [];
            for (const row of rows) applyUpdateOps(row, { $inc: n.$inc, $mul: n.$mul });
            if (rows.length) await unwrap(db.from(table).upsert(rows).select("id"));
          } else {
            throw error;
          }
        }
      }
      return { success: true, updated: ids.length, has_more: false };
    },
    async delete(id) {
      await unwrap(db.from(table).delete().eq("id", id));
      return { success: true };
    },
    async deleteMany(query) {
      const rows =
        (await unwrap<any[]>(applyFilter(db.from(table).delete(), query).select("id"))) ?? [];
      return { success: true, deleted: rows.length };
    },
    async importEntities(file) {
      try {
        const rows = parseCsv(await file.text());
        if (!rows.length) return { status: "success", details: "No rows to import", output: [] };
        const output = await handler.bulkCreate(rows as any);
        return { status: "success", details: `Imported ${output.length} rows`, output };
      } catch (err) {
        return {
          status: "error",
          details: (err as Error)?.message ?? "Import failed",
          output: null,
        };
      }
    },
    subscribe(cb) {
      // The doorbell pings for the whole schema; forward only this table's.
      return subscribeToChanges((payload) => {
        if (!payload.table || payload.table === table) cb(payload);
      });
    },
  };
  return handler;
}

export function createEntitiesModule(
  db: BoolDb,
  subscribeToChanges: (listener: (p: BoolChangePayload) => void) => () => void,
): EntitiesModule {
  const handlers = new Map<string, EntityHandler>();
  return new Proxy({} as EntitiesModule, {
    get(_target, prop) {
      // Guard non-string / thenable access so `await entities` or feature
      // probes don't get mistaken for a table named "then".
      if (typeof prop !== "string" || prop === "then") return undefined;
      let handler = handlers.get(prop);
      if (!handler) {
        handler = createEntityHandler(db, subscribeToChanges, prop);
        handlers.set(prop, handler);
      }
      return handler;
    },
  });
}
