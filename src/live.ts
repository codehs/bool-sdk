// The Bool live layer: a framework-agnostic sync engine over an entity table.
//
// This is the machinery `useEntity` (bool-sdk/react) sits on, and it exists
// because the hand-rolled version of this state machine — wire load(), refetch
// on every doorbell ping, layer optimistic writes — is exactly what generated
// app code kept getting subtly wrong: unguarded refetches raced each other
// (stale response lands last and rewinds the screen), a burst of pings caused
// a burst of full-list refetches, and a full-list replacement wiped optimistic
// rows whose writes were still in flight (the "items pop in and out" bug).
// Same reasoning as the auth React layer: own the state machine in one tested
// place; app code just renders.
//
// What it does, per change ding from the doorbell (see BoolChangePayload):
//   - COALESCE: pings arriving within a short window batch into ONE reconcile
//     pass, so a 50-row bulk write costs one round trip, not fifty.
//   - DELTA-APPLY: `{op: DELETE, id}` removes locally with no fetch at all;
//     other ops fetch just the changed rows by id through the gateway (full
//     auth + telemetry) and upsert them. A ding that carries the full `row`
//     (the future private-channel doorbell) is applied directly, zero fetches.
//   - ORDER: full reloads carry a monotonic sequence number; a stale response
//     that lands after a newer one is dropped, never applied.
//   - OPTIMISTIC LAYER: create/update/remove render immediately as an overlay
//     ON TOP of committed server state — a concurrent refetch can't wipe an
//     in-flight write, and a failed write rolls back by simply dropping its
//     overlay. Committed rows and the overlay share the same client-generated
//     id, so the doorbell echo of your own write reconciles to a no-op.
//
// Fallbacks are graceful: a ding with no id (an old-trigger fleet, or a table
// without an `id` column) degrades to one coalesced full reload — still
// strictly better than today's ping-per-refetch.
import type { BoolChangePayload } from "./client.js";
import type { EntityHandler, FilterQuery, SortSpec } from "./entities.js";

/** Rows the live layer manages. Entity tables always have a string `id`. */
export type EntityRow = { id: string } & Record<string, unknown>;

export type LiveQueryOptions = {
  /** Same filter DSL as `bool.entities.<table>.filter(...)`. */
  filter?: FilterQuery;
  /** `-col` descending, `col` ascending. Defaults to `-created_at`. */
  sort?: SortSpec;
  /** Max rows to keep in view. When set, the view is trimmed after sorting. */
  limit?: number;
};

export type LiveSnapshot<T extends EntityRow = EntityRow> = {
  data: T[];
  /** True until the first load settles (success or error). */
  loading: boolean;
  /** The most recent load/mutation error, cleared by the next success. */
  error: unknown;
};

// How long to gather dings before reconciling. Long enough to swallow a bulk
// write's per-row pings, short enough to be imperceptible next to the network
// hop the reconcile itself costs.
const COALESCE_MS = 50;

// A reconcile pass that would need to fetch more than this many distinct rows
// is cheaper as one full reload.
const MAX_KEYED_FETCH = 100;

/** Postgres-flavored comparator for a SortSpec: ascending puts NULLs last,
 * descending puts them first (matching the server's default order, so a
 * delta-applied row lands where the next full load would put it). Ties break
 * on id so the view is stable across reconciles. */
export function compareBySort<T extends EntityRow>(sort: SortSpec = "-created_at") {
  const desc = sort.startsWith("-");
  const col = sort.replace(/^[-+]/, "");
  return (a: T, b: T): number => {
    const av = a[col] as string | number | null | undefined;
    const bv = b[col] as string | number | null | undefined;
    if (av != null || bv != null) {
      if (av == null) return desc ? -1 : 1;
      if (bv == null) return desc ? 1 : -1;
      if (av < bv) return desc ? 1 : -1;
      if (av > bv) return desc ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** Does one Mongo-style operator hold for a row value? Mirrors the SQL the
 * server-side translation produces — including three-valued logic: a NULL
 * column fails every comparison except an explicit null/exists check, exactly
 * as PostgREST excludes those rows. */
function operatorMatches(v: unknown, op: string, operand: unknown): boolean {
  switch (op) {
    case "$eq":
      return operand === null ? v == null : v === operand;
    case "$exists":
      return operand ? v != null : v == null;
    default:
      break;
  }
  // SQL: NULL <op> anything → NULL → row excluded.
  if (v == null) return false;
  switch (op) {
    case "$ne":
      return operand === null ? true : v !== operand;
    case "$gt":
      return (v as never) > (operand as never);
    case "$gte":
      return (v as never) >= (operand as never);
    case "$lt":
      return (v as never) < (operand as never);
    case "$lte":
      return (v as never) <= (operand as never);
    case "$in":
      return Array.isArray(operand) && operand.includes(v);
    case "$nin":
      return Array.isArray(operand) && !operand.includes(v);
    case "$regex":
      // POSIX ~ vs JS RegExp — identical for the common patterns app code
      // writes; exotic POSIX classes may diverge until the next full load.
      try {
        return new RegExp(String(operand)).test(String(v));
      } catch {
        return false;
      }
    case "$all":
      return (
        Array.isArray(v) && Array.isArray(operand) && operand.every((x) => (v as unknown[]).includes(x))
      );
    case "$not": {
      const [innerOp, innerVal] = Object.entries((operand ?? {}) as Record<string, unknown>)[0] ?? [];
      if (!innerOp) return true;
      return !operatorMatches(v, innerOp, innerVal);
    }
    default:
      return true; // unsupported operator — server ignores it too
  }
}

/** Client-side evaluation of the entities filter DSL, used to decide whether a
 * changed row still belongs in a filtered live view without re-running the
 * whole query. Mirrors the server translation in entities.ts; on any
 * divergence the next full load is the source of truth. */
export function matchesFilter(row: Record<string, unknown>, query: FilterQuery): boolean {
  for (const [column, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (column === "$and") {
      if (!(value as FilterQuery[]).every((sub) => matchesFilter(row, sub))) return false;
    } else if (column === "$or") {
      if (!(value as FilterQuery[]).some((sub) => matchesFilter(row, sub))) return false;
    } else if (column === "$nor") {
      if ((value as FilterQuery[]).some((sub) => matchesFilter(row, sub))) return false;
    } else {
      const v = row[column];
      if (value === null) {
        if (v != null) return false;
      } else if (Array.isArray(value)) {
        if (v == null || !(value as unknown[]).includes(v)) return false;
      } else if (typeof value === "object") {
        for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
          if (operand === undefined) continue;
          if (!operatorMatches(v, op, operand)) return false;
        }
      } else if (v !== value) {
        return false;
      }
    }
  }
  return true;
}

type PendingOp<T extends EntityRow> =
  | { kind: "create"; id: string; row: Partial<T> }
  | { kind: "update"; id: string; patch: Partial<T> }
  | { kind: "remove"; id: string };

/** Generate a client-side row id (the optimistic-UI cornerstone: ONE id shared
 * by the optimistic row, the insert, and the doorbell echo). */
function newRowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Non-crypto fallback for exotic runtimes; collision odds are irrelevant at
  // per-user-session row counts.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class LiveEntityStore<T extends EntityRow = EntityRow> {
  /** Committed (server-confirmed) rows by id. */
  private server = new Map<string, T>();
  /** Optimistic overlay, in creation order, applied over `server`. */
  private pending: PendingOp<T>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: LiveSnapshot<T> = { data: [], loading: true, error: null };
  private queue: BoolChangePayload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic full-load counter — the anti-rewind guard. Only the response to
   * the NEWEST load may apply; anything else is a stale answer arriving late. */
  private loadSeq = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private handler: EntityHandler<T>,
    private opts: LiveQueryOptions = {},
  ) {}

  /** Subscribe to the doorbell and run the initial load. Returns a stop
   * function; the store is restartable (React StrictMode mounts twice). */
  start(): () => void {
    this.unsubscribe?.();
    this.unsubscribe = this.handler.subscribe((p) => this.onDing(p));
    void this.load();
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.flushTimer !== null) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.queue = [];
    };
  }

  /** Register a snapshot listener (useSyncExternalStore-shaped). */
  onSnapshot(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The current immutable snapshot. Reference-stable between changes. */
  getSnapshot(): LiveSnapshot<T> {
    return this.snapshot;
  }

  /** Force a full reload (sequenced like any other). */
  async refetch(): Promise<void> {
    await this.load();
  }

  // ---- optimistic mutations -------------------------------------------------
  // Each renders instantly via the overlay, settles into `server` on success,
  // and rolls back by dropping its overlay on failure (error surfaced on the
  // snapshot, never thrown — the view must keep rendering).

  async create(fields: Partial<T>): Promise<T | null> {
    const id = typeof fields.id === "string" ? fields.id : newRowId();
    const op: PendingOp<T> = { kind: "create", id, row: { ...fields, id } };
    this.pending.push(op);
    this.emit();
    try {
      const created = await this.handler.create({ ...fields, id } as Partial<T>);
      this.server.set(id, created);
      this.snapshot = { ...this.snapshot, error: null };
      return created;
    } catch (error) {
      this.snapshot = { ...this.snapshot, error };
      return null;
    } finally {
      this.pending = this.pending.filter((p) => p !== op);
      this.emit();
    }
  }

  async update(id: string, fields: Partial<T>): Promise<T | null> {
    const op: PendingOp<T> = { kind: "update", id, patch: fields };
    this.pending.push(op);
    this.emit();
    try {
      const updated = await this.handler.update(id, fields);
      this.server.set(id, updated);
      this.snapshot = { ...this.snapshot, error: null };
      return updated;
    } catch (error) {
      this.snapshot = { ...this.snapshot, error };
      return null;
    } finally {
      this.pending = this.pending.filter((p) => p !== op);
      this.emit();
    }
  }

  async remove(id: string): Promise<boolean> {
    const op: PendingOp<T> = { kind: "remove", id };
    this.pending.push(op);
    this.emit();
    try {
      await this.handler.delete(id);
      this.server.delete(id);
      this.snapshot = { ...this.snapshot, error: null };
      return true;
    } catch (error) {
      this.snapshot = { ...this.snapshot, error };
      return false;
    } finally {
      this.pending = this.pending.filter((p) => p !== op);
      this.emit();
    }
  }

  // ---- loading & reconciling ------------------------------------------------

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const rows = this.opts.filter
        ? await this.handler.filter(this.opts.filter, this.opts.sort, this.opts.limit)
        : await this.handler.list(this.opts.sort, this.opts.limit);
      if (seq !== this.loadSeq) return; // a newer load superseded this one
      this.server = new Map(rows.map((r) => [r.id, r]));
      this.snapshot = { ...this.snapshot, loading: false, error: null };
      this.emit();
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.snapshot = { ...this.snapshot, loading: false, error };
      this.emit();
    }
  }

  private onDing(p: BoolChangePayload): void {
    this.queue.push(p);
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, COALESCE_MS);
    }
  }

  private async flush(): Promise<void> {
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;

    // Collapse the batch to one final op per id (a row inserted then deleted
    // within the window nets out to its LAST op). Any ding without an id means
    // we can't reconcile precisely — degrade the whole pass to one full load.
    const finalOps = new Map<string, BoolChangePayload>();
    for (const p of batch) {
      if (!p.id) return void this.load();
      finalOps.set(p.id, p);
    }

    let changed = false;
    const toFetch: string[] = [];
    for (const [id, p] of finalOps) {
      if (p.op === "DELETE") {
        if (this.server.delete(id)) changed = true;
      } else if (p.row) {
        // Row rode the ding (private-channel doorbell) — apply directly.
        changed = this.applyRow(id, p.row as T) || changed;
      } else {
        toFetch.push(id);
      }
    }
    if (changed) this.emit();

    if (toFetch.length === 0) return;
    if (toFetch.length > MAX_KEYED_FETCH) return void this.load();

    try {
      const rows = await this.handler.filter(
        { id: toFetch } as FilterQuery,
        this.opts.sort,
        toFetch.length,
      );
      const returned = new Set(rows.map((r) => r.id));
      let applied = false;
      for (const row of rows) applied = this.applyRow(row.id, row) || applied;
      // Requested but absent: deleted meanwhile, or not visible to this viewer
      // (RLS) — either way it doesn't belong in the view.
      for (const id of toFetch) {
        if (!returned.has(id) && this.server.delete(id)) applied = true;
      }
      if (applied) this.emit();
    } catch {
      // Keyed reconcile failed (offline blip, gateway hiccup) — fall back to a
      // sequenced full load rather than leaving the view stale.
      void this.load();
    }
  }

  /** Upsert one committed row, honoring the view filter: a row that no longer
   * matches drops out, one that now matches drops in. Returns whether the
   * committed state changed. */
  private applyRow(id: string, row: T): boolean {
    const belongs = !this.opts.filter || matchesFilter(row, this.opts.filter);
    if (!belongs) return this.server.delete(id);
    this.server.set(id, row);
    return true;
  }

  // ---- view computation -----------------------------------------------------

  private emit(): void {
    const byId = new Map(this.server);
    // Overlay optimistic ops in creation order. Creates and updates stay
    // visible even if they wouldn't match the view filter — hiding the row the
    // user JUST touched reads as data loss; the next committed reconcile
    // settles membership.
    for (const op of this.pending) {
      if (op.kind === "create") {
        byId.set(op.id, { ...(byId.get(op.id) ?? {}), ...op.row } as T);
      } else if (op.kind === "update") {
        const base = byId.get(op.id);
        if (base) byId.set(op.id, { ...base, ...op.patch });
      } else {
        byId.delete(op.id);
      }
    }
    let data = [...byId.values()].sort(compareBySort<T>(this.opts.sort));
    if (this.opts.limit !== undefined && data.length > this.opts.limit) {
      data = data.slice(0, this.opts.limit);
    }
    this.snapshot = { ...this.snapshot, data };
    for (const l of this.listeners) l();
  }
}
