// The Bool entities layer: a Base44-style data API over the gateway-routed
// Supabase client. App code (and the AI that writes it) works with
// `bool.entities.<table>` instead of raw `supabase.from(...)`, so a generated
// app never mentions Supabase, SQL, PostgREST, or credentials — the whole
// backend is invisible plumbing inside this package.
//
//   const todos = await bool.entities.todos.list("-created_at");
//   const one   = await bool.entities.todos.create({ title: "hi" });
//   await bool.entities.todos.update(one.id, { done: true });
//
// Methods return the row data directly and THROW on error (unlike supabase-js's
// `{ data, error }`), so app code reads clean. Every method is a thin,
// well-understood translation to what `db` (the gateway client) already does.
import type { BoolChangePayload, BoolDb } from "./client.js";

/** Sort by a column, `-col` for descending (`+col`/`col` ascending).
 * Entity tables always have `created_at`, so it's the default. */
export type SortSpec = string;

/** PostgREST comparison operators usable in a filter query. */
export type FilterOperators = Partial<{
  eq: unknown;
  neq: unknown;
  gt: unknown;
  gte: unknown;
  lt: unknown;
  lte: unknown;
  like: string;
  ilike: string;
  in: unknown[];
}>;

/**
 * A filter query. Each key is a column; the value is:
 *   - a scalar → exact match (`{ status: "active" }`)
 *   - `null` → IS NULL (`{ archived_at: null }`)
 *   - an array → matches any of (`{ id: ["a", "b"] }`)
 *   - an operator object → `{ count: { gte: 100 } }`
 */
export type FilterValue =
  | string
  | number
  | boolean
  | null
  | Array<string | number | boolean>
  | FilterOperators;
export type FilterQuery = Record<string, FilterValue>;

/** CRUD + realtime for one entity table. `T` defaults to `any` (untyped);
 * apps can pass a row type for autocomplete. */
export interface EntityHandler<T = any> {
  /** All rows, newest first by default. `limit` defaults to 50. */
  list(sort?: SortSpec, limit?: number, offset?: number): Promise<T[]>;
  /** Rows matching `query`. See {@link FilterQuery}. */
  filter(
    query: FilterQuery,
    sort?: SortSpec,
    limit?: number,
    offset?: number,
  ): Promise<T[]>;
  /** One row by id. Throws if it doesn't exist. */
  get(id: string): Promise<T>;
  /** Insert a row; returns the created row (with server-filled id/created_at). */
  create(values: Partial<T>): Promise<T>;
  /** Patch a row by id; returns the updated row. */
  update(id: string, values: Partial<T>): Promise<T>;
  /** Delete a row by id. */
  delete(id: string): Promise<void>;
  /** Fire `cb` whenever any row in THIS table changes (refetch on each ping —
   * the payload carries no row data). Returns an unsubscribe function. */
  subscribe(cb: (change: BoolChangePayload) => void): () => void;
}

/** Dynamic map: `entities.<anyTableName>` yields a handler for that table. */
export type EntitiesModule = { [table: string]: EntityHandler };

const DEFAULT_SORT = "-created_at";
const DEFAULT_LIMIT = 50;

// A supabase-js filter/query builder is chainable and thenable; we only need
// the handful of methods below, so keep it loosely typed rather than importing
// supabase-js's internal builder generics.
type QueryBuilder = any;

function applySort(query: QueryBuilder, sort: SortSpec): QueryBuilder {
  const ascending = !sort.startsWith("-");
  const column = sort.replace(/^[-+]/, "");
  return query.order(column, { ascending });
}

function applyFilter(query: QueryBuilder, filter: FilterQuery): QueryBuilder {
  let q = query;
  for (const [column, value] of Object.entries(filter)) {
    if (value === null) {
      q = q.is(column, null);
    } else if (Array.isArray(value)) {
      q = q.in(column, value);
    } else if (typeof value === "object") {
      for (const [op, operand] of Object.entries(value)) {
        if (operand === undefined) continue;
        // op is one of the PostgREST methods on the builder (eq/gt/in/like/…).
        q = q[op](column, operand);
      }
    } else {
      q = q.eq(column, value);
    }
  }
  return q;
}

function createEntityHandler(
  db: BoolDb,
  subscribeToChanges: (listener: (p: BoolChangePayload) => void) => () => void,
  table: string,
): EntityHandler {
  function paginate(query: QueryBuilder, limit: number, offset: number): QueryBuilder {
    return query.range(offset, offset + limit - 1);
  }
  return {
    async list(sort = DEFAULT_SORT, limit = DEFAULT_LIMIT, offset = 0) {
      const query = paginate(
        applySort(db.from(table).select("*"), sort),
        limit,
        offset,
      );
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
    async filter(filter, sort = DEFAULT_SORT, limit = DEFAULT_LIMIT, offset = 0) {
      const query = paginate(
        applySort(applyFilter(db.from(table).select("*"), filter), sort),
        limit,
        offset,
      );
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
    async get(id) {
      const { data, error } = await db.from(table).select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
    async create(values) {
      const { data, error } = await db.from(table).insert(values).select().single();
      if (error) throw error;
      return data;
    },
    async update(id, values) {
      const { data, error } = await db
        .from(table)
        .update(values)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    async delete(id) {
      const { error } = await db.from(table).delete().eq("id", id);
      if (error) throw error;
    },
    subscribe(cb) {
      // The doorbell pings for the whole schema; forward only this table's.
      return subscribeToChanges((payload) => {
        if (!payload.table || payload.table === table) cb(payload);
      });
    },
  };
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
