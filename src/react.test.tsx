import { beforeEach, describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { createBoolClient } from "./client";
import {
  AuthGate,
  BoolAuthProvider,
  takeResetTokenFromSearch,
  useBoolAuth,
  useEntity,
} from "./react";
import { __registerEntityUseQuery } from "./entities";

// SSR smoke tests: effects don't run in renderToString, so the provider is in
// its initial loading state — enough to pin the gate/hook contract without a
// browser. The full auth flow is covered in client.test.ts.

const CONFIG = {
  supabaseUrl: "https://upstream.supabase.test",
  supabaseAnonKey: "anon-key",
  schema: "bool_abc",
  appOrigin: "https://bool.test",
  slug: "my-app",
};

beforeEach(() => {
  globalThis.fetch = (async () => Response.json({ user: null })) as unknown as typeof fetch;
  (globalThis as any).sessionStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});

describe("BoolAuthProvider + AuthGate", () => {
  test("renders nothing while the initial session check is in flight", () => {
    createBoolClient(CONFIG);
    const html = renderToString(
      <BoolAuthProvider>
        <AuthGate fallback={<div>login</div>}>
          <div>app</div>
        </AuthGate>
      </BoolAuthProvider>,
    );
    expect(html).toBe("");
  });

  test("provider accepts an explicit client", () => {
    const client = createBoolClient(CONFIG);
    const html = renderToString(
      <BoolAuthProvider client={client}>
        <span>hi</span>
      </BoolAuthProvider>,
    );
    expect(html).toContain("hi");
  });
});

describe("useBoolAuth", () => {
  test("throws outside <BoolAuthProvider>", () => {
    function Naked() {
      useBoolAuth();
      return null;
    }
    expect(() => renderToString(<Naked />)).toThrow(
      "useBoolAuth must be used inside <BoolAuthProvider>",
    );
  });
});

// Regression coverage for the reported bug: a reset link left the
// `bool_reset_token` param in the URL forever (so signing out landed back on
// the "set a new password" screen), and AuthGate never even looked at the
// token when a session already existed (so a fresh reset link silently
// auto-signed the visitor in instead of prompting for a new password). The
// fix hinges on this pure extraction being correct — the DOM-touching glue in
// BoolAuthProvider (read once, replaceState) isn't exercisable without a
// browser, but this pins the string logic it depends on.
describe("takeResetTokenFromSearch", () => {
  test("extracts the token and clears it from an otherwise-empty search", () => {
    expect(takeResetTokenFromSearch("?bool_reset_token=abc123")).toEqual({
      token: "abc123",
      rest: "",
    });
  });

  test("preserves sibling params, order aside", () => {
    const { token, rest } = takeResetTokenFromSearch(
      "?utm_source=email&bool_reset_token=abc123&ref=x",
    );
    expect(token).toBe("abc123");
    expect(new URLSearchParams(rest).get("bool_reset_token")).toBeNull();
    expect(new URLSearchParams(rest).get("utm_source")).toBe("email");
    expect(new URLSearchParams(rest).get("ref")).toBe("x");
  });

  test("no token present — rest is unchanged, token is null", () => {
    expect(takeResetTokenFromSearch("?foo=bar")).toEqual({
      token: null,
      rest: "?foo=bar",
    });
  });

  test("empty search — no token, no rest", () => {
    expect(takeResetTokenFromSearch("")).toEqual({ token: null, rest: "" });
  });
});

// SSR smoke for useEntity: effects don't run in renderToString, so this pins
// the initial contract (loading, empty data, callable shape) without a
// browser. The live state machine itself is covered headlessly in live.test.ts.
describe("useEntity", () => {
  test("renders the initial loading snapshot on the server", () => {
    createBoolClient(CONFIG);
    function List() {
      const todos = useEntity("todos");
      return (
        <div>
          {todos.loading ? "loading" : "ready"}:{todos.data.length}
        </div>
      );
    }
    const html = renderToString(<List />);
    expect(html).toContain("loading");
    expect(html).toContain("0");
  });

  test("accepts an explicit client and returns mutation handles", () => {
    const client = createBoolClient(CONFIG);
    function Probe() {
      const t = useEntity("todos", { client, sort: "-created_at", limit: 5 });
      return <span>{typeof t.create === "function" ? "ok" : "bad"}</span>;
    }
    expect(renderToString(<Probe />)).toContain("ok");
  });
});

// bool.entities.<table>.useQuery() — the dot-path spelling of useEntity. Core
// is React-free, so the method only works because importing THIS entry
// registered the implementation; these tests pin both halves of that contract.
describe("bool.entities.<table>.useQuery", () => {
  test("renders the same initial live snapshot as useEntity", () => {
    const client = createBoolClient(CONFIG);
    function List() {
      const todos = client.entities.todos.useQuery({ sort: "-created_at", limit: 5 });
      return (
        <div>
          {todos.loading ? "loading" : "ready"}:{todos.data.length}
        </div>
      );
    }
    const html = renderToString(<List />);
    expect(html).toContain("loading");
    expect(html).toContain("0");
  });

  test("returns the full mutation surface (create/update/remove/refetch)", () => {
    const client = createBoolClient(CONFIG);
    function Probe() {
      const t = client.entities.todos.useQuery();
      const ok =
        typeof t.create === "function" &&
        typeof t.update === "function" &&
        typeof t.remove === "function" &&
        typeof t.refetch === "function";
      return <span>{ok ? "ok" : "bad"}</span>;
    }
    expect(renderToString(<Probe />)).toContain("ok");
  });

  test("without the React entry loaded, it throws instructions naming the fix", () => {
    // Module state is process-global (bun shares the module cache across test
    // files), so ALWAYS restore the impl — a dangling null here would break
    // every later useQuery test in the run, in whichever file runs next.
    const prev = __registerEntityUseQuery(null);
    try {
      const client = createBoolClient(CONFIG);
      expect(() => client.entities.todos.useQuery()).toThrow(/import "bool-sdk\/react"/);
      expect(() => client.entities.todos.useQuery()).toThrow(/\.list\(\)/);
    } finally {
      __registerEntityUseQuery(prev);
    }
  });

  test("an options literal typo is a type error, not a silent no-op", () => {
    // Compile-time pin: excess-property checking is the AI's guardrail here.
    const client = createBoolClient(CONFIG);
    function Probe() {
      // @ts-expect-error — "srot" is not an option; if this ever compiles, the
      // guardrail is gone and this test fails typecheck.
      const t = client.entities.todos.useQuery({ srot: "-created_at" });
      return <span>{String(!!t)}</span>;
    }
    expect(typeof Probe).toBe("function");
  });
});
