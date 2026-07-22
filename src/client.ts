// The Bool client for generated apps ("Bools") running on the Bool platform.
//
// What it does:
//   - REST + Storage calls are routed to the Bool gateway (/_bool/v1/db), which
//     injects the real credential server-side and pins the app's Postgres
//     schema. The Supabase anon key stays in the bundle (Supabase Realtime
//     requires it) but is powerless: a v2 schema has no anon/authenticated
//     grants, so a direct REST call 403s.
//   - Realtime connects directly to Supabase (the WS can't be proxied) and
//     subscribes to the app's PUBLIC, row-data-free Broadcast "doorbell"
//     channel `bool:<schema>` — no token needed (the payload is just
//     {table, op}; the data itself stays behind the gateway).
//   - `auth` (end-user auth) routes to the gateway's users plane
//     (/_bool/v1/users) so the app can offer its own signup/login without ever
//     handling a credential server-side.
//
// Keep this in sync with the gateway data route (/_bool/v1/db) and users route
// (/_bool/v1/users) in the Bool platform repo.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createEntitiesModule, type EntitiesModule } from "./entities.js";

/** Matches the server's append-only gateway path version. */
const GATEWAY_API = "v1";

// End-user session token, used ONLY in the cross-origin editor preview: the
// httpOnly session cookie can't ride cross-site requests from the sandbox, so
// the gateway returns the token in the login/signup body there and we replay it
// in the x-bool-eu-session header. Persisted in sessionStorage so it survives
// preview reloads. Stays empty on deployed apps (same-origin → the cookie is
// used, and the server never returns a token), so it's never exposed there.
const EU_SESSION_KEY = "bool_eu_session_token";

/** Everything the client needs to reach its Bool. Injected by Bool at boot
 * (the app's `src/lib/supabase.ts` passes these from `import.meta.env`). */
export type BoolClientConfig = {
  /** The shared user-apps Supabase project URL (VITE_SUPABASE_URL). */
  supabaseUrl: string;
  /** Public admission ticket only — has NO data grants on this app's schema,
   * so it cannot read anything directly. The gateway holds the credential
   * that can. (VITE_SUPABASE_ANON_KEY) */
  supabaseAnonKey: string;
  /** This app's private Postgres schema (VITE_BOOL_DB_SCHEMA). */
  schema: string;
  /** e.g. "bool.com" (VITE_BOOL_APP_HOST). */
  appHost?: string;
  /** e.g. "https://bool.com" (VITE_BOOL_APP_ORIGIN). */
  appOrigin?: string;
  /** The app's slug on the Bool platform (VITE_BOOL_SLUG). */
  slug?: string;
  /** Preview only: identifies the owner to the gateway (the cross-origin
   * sandbox can't send the live-gate cookie). Empty when deployed — the
   * cookie is used then. (VITE_BOOL_VIEWER_TOKEN) */
  viewerToken?: string;
  /** LOCAL / external development: a Bool data API key sent as the `api_key`
   * header on every gateway call, instead of the cookie/viewer-token identity a
   * deployed app uses. Two kinds (both minted by the platform):
   *   - `boolsk_…` — the project's OWNER/ADMIN key: full access to ALL rows
   *     (bypasses per-user RLS). For your own scripts/backends. SECRET — load
   *     it from an env var (`bool link` writes .env.bool), never commit it.
   *   - `boolk_…` — one END USER's personal key: acts exactly as that user.
   * With an apiKey set the client works from anywhere (Node, a local Vite app,
   * CI) — this is what `bool link` wires up. */
  apiKey?: string;
};

/** The signed-in end user (mirrors what the gateway returns from /me). Never
 * includes a password — that lives server-side only. */
export type BoolUser = {
  id: string;
  email: string;
  displayName: string | null;
  provider: "password" | "google";
  emailVerified: boolean;
  createdAt: string;
  /** The user's personal API key for external/programmatic calls (sent as the
   * `api_key` header). Acts exactly as this user — same per-user data scoping
   * as in the app. Lazily minted by the gateway on first /me; absent when the
   * deployment hasn't configured API keys. Rotate via auth.rotateApiKey(). */
  apiKey?: string;
};

export type AuthEvent = "SIGNED_IN" | "SIGNED_OUT";
export type AuthChangeListener = (event: AuthEvent, user: BoolUser | null) => void;
export type Credentials = { email: string; password: string };
export type AuthResult = { data: { user: BoolUser | null }; error: unknown };

/** This app's OWN end-user accounts. Mirrors `supabase.auth`'s shape so app
 * code (and the AI that writes it) already knows the surface. Every call hits
 * the gateway users plane with credentials so the httpOnly session cookie
 * flows; NOTHING sensitive lives client-side — the server hashes passwords and
 * owns the session cookie. Anonymous callers just get 401s from /me. */
export type BoolAuth = {
  signUp(credentials: Credentials): Promise<AuthResult>;
  signInWithPassword(credentials: Credentials): Promise<AuthResult>;
  signInWithOAuth(opts: { provider: "google" }): { data: unknown; error: unknown };
  signOut(): Promise<{ error: unknown }>;
  getUser(): Promise<AuthResult>;
  onAuthStateChange(callback: AuthChangeListener): {
    data: { subscription: { unsubscribe(): void } };
  };
  resetPasswordForEmail(email: string): Promise<{ data: unknown; error: unknown }>;
  confirmPasswordReset(opts: { token: string; password: string }): Promise<AuthResult>;
  /** Mint a replacement personal API key; the old one stops working
   * immediately. Returns the new key (also reflected by the next getUser()). */
  rotateApiKey(): Promise<{ data: { apiKey: string | null }; error: unknown }>;
};

/** A row-data-free change notification: some row in `table` saw `op`. Refetch
 * whatever you derive from that table — the ping never carries the data. */
export type BoolChangePayload = { table?: string; op?: string };

/** A JSON Schema describing the shape `bool.ai.generate` should return. Passed
 * straight to the gateway, which validates the model's output against it. e.g.
 * `{ type: "object", properties: { sentiment: { type: "string" } }, required: ["sentiment"] }`. */
export type BoolAiSchema = Record<string, unknown>;

/** Thrown when a bool.ai call fails. `status` is the gateway HTTP status and
 * `code` its machine-readable error (e.g. "out_of_ai_credits" on a 402,
 * "rate_limited" on a 429) so app code can branch without string-matching. */
export class BoolAiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, status: number) {
    super(`bool.ai failed: ${code} (${status})`);
    this.name = "BoolAiError";
    this.code = code;
    this.status = status;
  }
}

/** The AI battery — server-side AI with NO API key in the app bundle. Each call
 * routes through the Bool gateway (/_bool/v1/ai), which runs the prompt against
 * Bool's own provider credential and meters one AI credit against the app
 * owner's workspace. The key never reaches the client. Returns results directly
 * and THROWS a {@link BoolAiError} on failure (same ergonomics as `entities`). */
export type BoolAi = {
  /** Generate plain text from a prompt. */
  generate(prompt: string): Promise<string>;
  /** Generate structured output validated against a JSON Schema. Returns the
   * parsed object, typed as `T` when you supply it. */
  generate<T = unknown>(opts: { prompt: string; schema: BoolAiSchema }): Promise<T>;
  /** Stream generated text as it's produced — an async iterator of text chunks,
   * for typewriter UIs: `for await (const chunk of bool.ai.stream(p)) …`. */
  stream(prompt: string): AsyncIterable<string>;
};

/** The gateway-routed supabase-js client. Loosely typed on the schema-name
 * generic because each Bool runs in its own non-"public" schema. */
export type BoolDb = SupabaseClient<any, any, any, any, any>;

export type BoolClient = {
  /** The Supabase client, routed through the Bool gateway for REST + Storage.
   * Use it exactly like a normal supabase-js client: `.from(...)`, `.storage`,
   * `.channel(...)`. Do NOT use `db.auth` — end-user auth is `client.auth`. */
  db: BoolDb;
  /** The data API: `entities.<table>.list/filter/get/create/update/delete`.
   * The recommended way to read/write app data — hides Supabase entirely. */
  entities: EntitiesModule;
  /** End-user auth for this app (gateway users plane). */
  auth: BoolAuth;
  /** The AI battery: `ai.generate(prompt)` / `ai.generate({prompt, schema})` /
   * `ai.stream(prompt)`. Server-side AI with no API key in the bundle. */
  ai: BoolAi;
  /** This app's private Postgres schema name. */
  schema: string;
  /** Subscribe to the app's realtime "doorbell": fires whenever any row in the
   * app's schema changes, with a row-data-free {table, op} payload. REFETCH on
   * each ping. Returns an unsubscribe function. */
  subscribeToChanges(listener: (payload: BoolChangePayload) => void): () => void;
};

// The last-created client, used by the React layer (bool-sdk/react) so app
// components don't have to thread the client through props. Last-created wins
// so a hot-reloaded `src/lib/supabase.ts` re-registers its fresh client.
let defaultClient: BoolClient | null = null;

export function getDefaultBoolClient(): BoolClient {
  if (!defaultClient) {
    throw new Error(
      "No Bool client exists yet — call createBoolClient() first. " +
        "(Bool apps do this in src/lib/supabase.ts; import from there.)",
    );
  }
  return defaultClient;
}

export function setDefaultBoolClient(client: BoolClient): void {
  defaultClient = client;
}

export function createBoolClient(config: BoolClientConfig): BoolClient {
  const {
    supabaseUrl,
    supabaseAnonKey,
    schema,
    appHost = "",
    appOrigin = "",
    slug = "",
    viewerToken = "",
    apiKey = "",
  } = config;

  let euSessionToken = (() => {
    try {
      return sessionStorage.getItem(EU_SESSION_KEY) ?? "";
    } catch {
      return "";
    }
  })();
  function setEuSessionToken(token: string | null): void {
    euSessionToken = token ?? "";
    try {
      if (token) sessionStorage.setItem(EU_SESSION_KEY, token);
      else sessionStorage.removeItem(EU_SESSION_KEY);
    } catch {
      /* sessionStorage unavailable — fall back to in-memory only */
    }
  }

  // Where the gateway lives, decided at runtime by where the app is running:
  //  - Deployed at <slug>.<host>: the gateway is same-origin (the platform
  //    proxy rewrites /_bool → /served/<slug>/_bool), so use a relative path —
  //    no CORS.
  //  - Preview (sandbox) or a custom domain: reach the slug gateway
  //    cross-origin.
  function boolGatewayBase(): string {
    if (
      appHost &&
      slug &&
      typeof location !== "undefined" &&
      location.host === slug + "." + appHost
    ) {
      return "";
    }
    if (appOrigin && slug) return appOrigin + "/served/" + slug;
    return "";
  }
  const GATEWAY = boolGatewayBase();

  // Route REST + Storage through the gateway; leave everything else (the
  // realtime WebSocket, in particular) connecting directly to Supabase.
  const proxyFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, supabaseUrl);
    if (url.pathname.startsWith("/rest/v1") || url.pathname.startsWith("/storage/v1")) {
      const headers = new Headers(init?.headers ?? {});
      if (viewerToken) headers.set("x-bool-viewer", viewerToken);
      if (euSessionToken) headers.set("x-bool-eu-session", euSessionToken);
      if (apiKey) headers.set("api_key", apiKey);
      // credentials:include so the live-gate identity cookie flows to the
      // gateway (same-origin or custom-domain); the viewer token covers the
      // cross-origin preview.
      return fetch(`${GATEWAY}/_bool/${GATEWAY_API}/db${url.pathname}${url.search}`, {
        ...init,
        headers,
        credentials: "include",
      });
    }
    return fetch(input as RequestInfo, init);
  };

  const db = createClient(supabaseUrl, supabaseAnonKey, {
    db: { schema },
    // Cast: Bun's `typeof fetch` demands a `preconnect` property that a plain
    // fetch-shaped function doesn't have; supabase-js only ever calls it.
    global: { fetch: proxyFetch as unknown as typeof fetch },
  });

  const authListeners = new Set<AuthChangeListener>();
  function notifyAuth(user: BoolUser | null): void {
    for (const cb of authListeners) cb(user ? "SIGNED_IN" : "SIGNED_OUT", user);
  }
  async function usersCall(
    path: string,
    init?: RequestInit,
  ): Promise<{ res: Response; body: any }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (viewerToken) headers["x-bool-viewer"] = viewerToken;
    if (euSessionToken) headers["x-bool-eu-session"] = euSessionToken;
    if (apiKey) headers["api_key"] = apiKey;
    const res = await fetch(`${GATEWAY}/_bool/${GATEWAY_API}/users${path}`, {
      ...init,
      headers,
      credentials: "include",
    });
    let body: any = null;
    try {
      body = await res.json();
    } catch (_) {}
    return { res, body };
  }

  const auth: BoolAuth = {
    async signUp({ email, password }: Credentials): Promise<AuthResult> {
      const { res, body } = await usersCall("/signup", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) return { data: { user: null }, error: body || { error: "signup_failed" } };
      if (body.sessionToken) setEuSessionToken(body.sessionToken);
      notifyAuth(body.user);
      return { data: { user: body.user }, error: null };
    },
    async signInWithPassword({ email, password }: Credentials): Promise<AuthResult> {
      const { res, body } = await usersCall("/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) return { data: { user: null }, error: body || { error: "invalid_login" } };
      if (body.sessionToken) setEuSessionToken(body.sessionToken);
      notifyAuth(body.user);
      return { data: { user: body.user }, error: null };
    },
    signInWithOAuth({ provider }: { provider: "google" }): { data: unknown; error: unknown } {
      if (provider !== "google") {
        return { data: null, error: { error: "unsupported_provider" } };
      }
      const returnTo = location.pathname + location.search;
      const startBase =
        `${GATEWAY}/_bool/${GATEWAY_API}/users/oauth/google/start?returnTo=` +
        encodeURIComponent(returnTo);
      // Cross-origin editor preview (viewerToken present): a top-level redirect
      // would navigate the whole editor tab away and can't hand the session
      // back across origins. Run OAuth in a POPUP instead — the editor stays
      // put, and the finish page postMessages the session token back here
      // (which we store and replay via x-bool-eu-session, exactly like
      // password login).
      if (viewerToken && typeof window.open === "function") {
        // Send the viewer token so the gateway will honor popup mode. Deployed
        // apps have no viewer token and use the redirect flow below, so the
        // gateway refuses popup mode for them (stops a hostile page opening the
        // popup with its own opener). The pickup nonce is how we get the
        // session back: in the preview the app runs on a foreign sandbox
        // origin, so Google's COOP severs the popup's window.opener and the
        // finish postMessage never arrives. We POLL the gateway for the token
        // stashed under this nonce instead — the opener never has to receive a
        // message. The postMessage listener stays as a fast path for the cases
        // where the opener does survive.
        const pickup = (function () {
          try {
            return crypto.randomUUID();
          } catch (_) {}
          const a = new Uint8Array(24);
          crypto.getRandomValues(a);
          return Array.from(a, function (b) {
            return b.toString(16).padStart(2, "0");
          }).join("");
        })();
        const startUrl =
          startBase +
          "&flow=popup&opener=" +
          encodeURIComponent(location.origin) +
          "&viewer=" +
          encodeURIComponent(viewerToken) +
          "&pickup=" +
          encodeURIComponent(pickup);
        // CRITICAL: a cross-origin iframe (the editor preview) DISOWNS the
        // popup — window.open() returns null even though the popup really
        // opened. So we must NOT gate the poll on this handle (doing so is why
        // sign-in worked in a top-level tab but did nothing in the editor). The
        // session comes back via the SERVER pickup rendezvous (the nonce),
        // which needs no window reference, so open the popup and poll
        // UNCONDITIONALLY.
        const popup = window.open(startUrl, "bool-oauth-google", "width=480,height=680");
        let settled = false;
        const onMessage = (e: MessageEvent) => {
          // Fast path when the opener survives: trust only the gateway origin.
          if (e.origin !== appOrigin) return;
          const d = e.data as { type?: string; ok?: boolean; sessionToken?: string } | null;
          if (!d || d.type !== "bool-oauth-result") return;
          if (d.ok && d.sessionToken) finish(d.sessionToken);
        };
        function finish(token: string) {
          if (settled) return;
          settled = true;
          window.removeEventListener("message", onMessage);
          setEuSessionToken(token);
          void auth.getUser().then(({ data }) => notifyAuth(data.user));
          try {
            if (popup) popup.close();
          } catch (_) {}
        }
        window.addEventListener("message", onMessage);
        // COOP-proof path: poll for the token the callback stashes under
        // `pickup`. Poll purely on time (every 1s, ~2 min cap) — NEVER on
        // popup.closed/handle: in the editor the handle is null and, once the
        // popup reaches Google, COOP severs it anyway. The nonce rendezvous is
        // what actually carries the token.
        let tries = 0;
        const stopPolling = () => window.removeEventListener("message", onMessage);
        const poll = async () => {
          if (settled) return;
          try {
            const { res, body } = await usersCall(
              "/oauth/google/pickup?key=" + encodeURIComponent(pickup),
              { method: "GET" },
            );
            if (res.ok && body && body.sessionToken) {
              finish(body.sessionToken);
              return;
            }
          } catch (_) {
            /* keep polling */
          }
          if (settled) return;
          if (++tries > 120) {
            stopPolling();
            return;
          }
          setTimeout(poll, 1000);
        };
        setTimeout(poll, 1000);
        return { data: { provider, url: null }, error: null };
      }
      // Editor preview but window.open is unavailable: don't navigate the
      // editor tab to Google (loses work). Google sign-in works on the
      // PUBLISHED app.
      if (viewerToken) {
        return {
          data: { provider, url: null },
          error: {
            error: "popup_blocked",
            message:
              "Allow pop-ups to sign in with Google in the editor preview, or use email + password. Google sign-in works normally on your published app.",
          },
        };
      }
      // Deployed (same-origin): full-page redirect THROUGH the gateway (it
      // runs the PKCE dance + bounce). Google refuses to load its sign-in
      // inside an iframe, so break out of any embedding frame.
      (window.top ?? window).location.href = startBase;
      return { data: { provider, url: null }, error: null };
    },
    async signOut(): Promise<{ error: unknown }> {
      await usersCall("/logout", { method: "POST" });
      setEuSessionToken(null);
      notifyAuth(null);
      return { error: null };
    },
    async getUser(): Promise<AuthResult> {
      const { res, body } = await usersCall("/me", { method: "GET" });
      return { data: { user: res.ok && body ? body.user : null }, error: null };
    },
    async rotateApiKey(): Promise<{ data: { apiKey: string | null }; error: unknown }> {
      const { res, body } = await usersCall("/api-key/rotate", { method: "POST" });
      if (!res.ok) {
        return { data: { apiKey: null }, error: body || { error: "rotate_failed" } };
      }
      return { data: { apiKey: body?.apiKey ?? null }, error: null };
    },
    onAuthStateChange(callback: AuthChangeListener) {
      authListeners.add(callback);
      auth
        .getUser()
        .then(({ data }) =>
          callback(data.user ? "SIGNED_IN" : "SIGNED_OUT", data.user),
        )
        .catch(() => callback("SIGNED_OUT", null));
      return {
        data: {
          subscription: {
            unsubscribe(): void {
              authListeners.delete(callback);
            },
          },
        },
      };
    },
    async resetPasswordForEmail(email: string): Promise<{ data: unknown; error: unknown }> {
      // Always resolves ok — the server responds generically so this can't be
      // used to probe which emails have accounts.
      await usersCall("/reset/request", { method: "POST", body: JSON.stringify({ email }) });
      return { data: {}, error: null };
    },
    // Complete a reset: the reset page reads ?bool_reset_token=... and calls
    // this with the new password. On success the user is signed in.
    async confirmPasswordReset({
      token,
      password,
    }: {
      token: string;
      password: string;
    }): Promise<AuthResult> {
      const { res, body } = await usersCall("/reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) return { data: { user: null }, error: body || { error: "reset_failed" } };
      if (body.sessionToken) setEuSessionToken(body.sessionToken);
      notifyAuth(body.user);
      return { data: { user: body.user }, error: null };
    },
  };

  // bool.ai battery — POST the prompt to the gateway AI plane
  // (/_bool/v1/ai/*), which runs it against Bool's provider credential and
  // meters one AI credit against the app owner. credentials:include + the
  // viewer/eu-session identity headers mirror the db and users planes so the
  // same live-gate identity flows (same-origin cookie deployed, viewer token
  // cross-origin in preview).
  function aiHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (viewerToken) headers["x-bool-viewer"] = viewerToken;
    if (euSessionToken) headers["x-bool-eu-session"] = euSessionToken;
    if (apiKey) headers["api_key"] = apiKey;
    return headers;
  }
  const ai: BoolAi = {
    // One impl covers both overloads (string prompt → text; {prompt, schema} →
    // structured object). The public BoolAi type exposes the two typed forms.
    generate: (async (
      promptOrOpts: string | { prompt: string; schema?: BoolAiSchema },
    ): Promise<unknown> => {
      const opts =
        typeof promptOrOpts === "string" ? { prompt: promptOrOpts } : promptOrOpts;
      const res = await fetch(`${GATEWAY}/_bool/${GATEWAY_API}/ai/generate`, {
        method: "POST",
        headers: aiHeaders(),
        credentials: "include",
        body: JSON.stringify({ prompt: opts.prompt, schema: opts.schema }),
      });
      let body: any = null;
      try {
        body = await res.json();
      } catch (_) {}
      if (!res.ok) throw new BoolAiError(body?.error ?? "ai_failed", res.status);
      // Structured → { object }; plain → { text }. Return the inner value.
      return opts.schema ? body?.object : body?.text;
    }) as BoolAi["generate"],

    async *stream(prompt: string): AsyncIterable<string> {
      const res = await fetch(`${GATEWAY}/_bool/${GATEWAY_API}/ai/stream`, {
        method: "POST",
        headers: aiHeaders(),
        credentials: "include",
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok || !res.body) {
        let body: any = null;
        try {
          body = await res.json();
        } catch (_) {}
        throw new BoolAiError(body?.error ?? "ai_failed", res.status);
      }
      // The gateway streams raw text deltas (text/plain). Decode and yield each
      // chunk as it arrives.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) yield chunk;
        }
        const tail = decoder.decode();
        if (tail) yield tail;
      } finally {
        reader.releaseLock();
      }
    },
  };

  // Realtime "doorbell": the app schema's grants are revoked, so Supabase
  // `postgres_changes` never fires. Instead the server broadcasts a
  // row-data-free ping on the PUBLIC channel "bool:" + schema whenever any
  // row changes. Subscribe with the anon key (no token needed) and REFETCH
  // on each ping.
  const subscribeToChanges = (
    listener: (payload: BoolChangePayload) => void,
  ): (() => void) => {
    const channel = db
      .channel("bool:" + schema)
      .on("broadcast", { event: "*" }, (msg) =>
        listener((msg as { payload?: BoolChangePayload }).payload ?? {}),
      )
      .subscribe();
    return () => {
      void db.removeChannel(channel);
    };
  };

  const client: BoolClient = {
    db,
    entities: createEntitiesModule(db, subscribeToChanges),
    auth,
    ai,
    schema,
    subscribeToChanges,
  };

  setDefaultBoolClient(client);
  return client;
}
