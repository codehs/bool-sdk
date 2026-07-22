// Bundled starter apps for `bool create`. Each template is a path→content map
// written verbatim into the new project directory. Kept as plain string
// literals (zero deps) so the CLI can scaffold offline; the only network step
// in `create` is the project/entity API calls.
//
// The apps use bool-sdk's `createBoolClient`, fed the VITE_BOOL_*/VITE_SUPABASE_*
// vars Bool injects at build/deploy time (see runtimeEnv in the platform). The
// `todos` entity is PUBLIC (one shared list, no per-user isolation) so the
// deployed app works for any visitor with no sign-in.

// Keep in sync with the CLI's own version so the scaffolded app pulls the
// matching client. Injected into package.json at scaffold time.
export const TEMPLATE_BOOL_SDK_VERSION = "0.2.0-next.14";

function packageJson(name: string): string {
  return (
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        scripts: {
          dev: "vite --host",
          build: "vite build",
          preview: "vite preview --host",
        },
        dependencies: {
          // bool-sdk declares @supabase/supabase-js as a peer, so the app must
          // install it directly — else the deploy build fails to resolve it.
          "@supabase/supabase-js": "^2.105.0",
          "bool-sdk": TEMPLATE_BOOL_SDK_VERSION,
          react: "^19.2.0",
          "react-dom": "^19.2.0",
        },
        devDependencies: {
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          "@vitejs/plugin-react": "^4.3.4",
          typescript: "^5.7.0",
          vite: "^6.0.7",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * The default `bool create` app: a working todo list backed by a public `todos`
 * entity. Returns a path→content map for the given project name.
 */
export function todoTemplate(name: string): Record<string, string> {
  return {
    "package.json": packageJson(name),

    "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,

    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2020",
            useDefineForClassFields: true,
            lib: ["ES2020", "DOM", "DOM.Iterable"],
            module: "ESNext",
            skipLibCheck: true,
            moduleResolution: "bundler",
            jsx: "react-jsx",
            strict: true,
            noEmit: true,
            types: ["vite/client"],
          },
          include: ["src"],
        },
        null,
        2,
      ) + "\n",

    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,

    "src/vite-env.d.ts": `/// <reference types="vite/client" />
`,

    // Bool-provided gateway client. Bool injects the VITE_BOOL_*/VITE_SUPABASE_*
    // values at build/deploy; the anon key alone has no data grants, so all data
    // flows through the gateway.
    "src/lib/bool.ts": `import { createBoolClient } from "bool-sdk";

export const bool = createBoolClient({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL!,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY!,
  schema: import.meta.env.VITE_BOOL_DB_SCHEMA!,
  appHost: import.meta.env.VITE_BOOL_APP_HOST,
  appOrigin: import.meta.env.VITE_BOOL_APP_ORIGIN,
  slug: import.meta.env.VITE_BOOL_SLUG,
  // Preview only; empty when deployed (same-origin cookie is used then).
  viewerToken: import.meta.env.VITE_BOOL_VIEWER_TOKEN,
});
`,

    "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,

    "src/App.tsx": `import { useEffect, useState, type FormEvent } from "react";
import { bool } from "./lib/bool";

type Todo = {
  id: string;
  title: string;
  completed: boolean;
  created_at: string;
};

export default function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setTodos((await bool.entities.todos.list("-created_at")) as Todo[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    setTitle("");
    await bool.entities.todos.create({ title: text, completed: false });
    load();
  }

  async function toggle(todo: Todo) {
    await bool.entities.todos.update(todo.id, { completed: !todo.completed });
    load();
  }

  async function remove(todo: Todo) {
    await bool.entities.todos.delete(todo.id);
    load();
  }

  return (
    <main className="app">
      <h1>${name}</h1>
      <form className="add" onSubmit={add}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
        />
        <button type="submit">Add</button>
      </form>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <ul className="list">
          {todos.map((t) => (
            <li key={t.id} className={t.completed ? "done" : ""}>
              <label>
                <input
                  type="checkbox"
                  checked={t.completed}
                  onChange={() => toggle(t)}
                />
                <span>{t.title}</span>
              </label>
              <button className="del" onClick={() => remove(t)} aria-label="Delete">
                ×
              </button>
            </li>
          ))}
          {todos.length === 0 && (
            <li className="empty muted">Nothing yet — add your first task.</li>
          )}
        </ul>
      )}

      <footer className="muted">
        Built with Bool · scaffolded by <code>bool create</code>
      </footer>
    </main>
  );
}
`,

    "src/index.css": `:root {
  color-scheme: light dark;
  font-family: system-ui, -apple-system, sans-serif;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: Canvas;
  color: CanvasText;
}
.app {
  max-width: 32rem;
  margin: 4rem auto;
  padding: 0 1.25rem;
}
h1 {
  font-size: 1.75rem;
  margin: 0 0 1.25rem;
}
.add {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}
.add input {
  flex: 1;
  padding: 0.6rem 0.75rem;
  font-size: 1rem;
  border: 1px solid color-mix(in oklab, CanvasText 25%, transparent);
  border-radius: 0.5rem;
  background: transparent;
  color: inherit;
}
.add button {
  padding: 0.6rem 1rem;
  font-size: 1rem;
  border: 0;
  border-radius: 0.5rem;
  background: CanvasText;
  color: Canvas;
  cursor: pointer;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.6rem 0.25rem;
  border-bottom: 1px solid color-mix(in oklab, CanvasText 12%, transparent);
}
.list label {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  cursor: pointer;
}
.list li.done span {
  text-decoration: line-through;
  opacity: 0.55;
}
.del {
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 1.25rem;
  line-height: 1;
  opacity: 0.5;
  cursor: pointer;
}
.del:hover {
  opacity: 1;
}
.empty {
  justify-content: center;
  border: 0;
}
.muted {
  opacity: 0.6;
}
.error {
  color: #d33;
}
footer {
  margin-top: 2rem;
  font-size: 0.85rem;
  text-align: center;
}
`,

    ".gitignore": `node_modules
dist
.env.bool
`,

    // Public todos: one shared list, no per-user isolation, so the deployed app
    // reads/writes with no sign-in. id/created_at are managed by Bool.
    "bool/entities/todos.jsonc": `{
  "name": "todos",
  "type": "object",
  "properties": {
    "title": { "type": "string", "description": "The task text" },
    "completed": { "type": "boolean", "default": false }
  },
  "required": ["title"],
  "x-bool-access": "public"
}
`,
  };
}
