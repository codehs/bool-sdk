# Local Development — Build on Your Machine

Develop an app on your own computer using a Bool project as your backend, then publish it to Bool hosting. No infrastructure to manage, no deployment configs to learn — just your code and the Bool SDK.

## What You Get

- **Data management**: Full control over your schema with TypeScript types
- **End-user accounts**: Isolated auth per app (signup, signin, password reset)
- **File storage**: Store and serve files through your app
- **AI integration**: Use Bool's AI credits server-side
- **Realtime updates**: Postgres-backed subscriptions
- **Published URL**: `https://<slug>.bool.so` when you're ready

## Your First App

### 1. Link Your Bool Project

Create a personal access token in Bool (Settings → Access tokens), then:

```bash
export BOOL_TOKEN=bool_live_xxxxx
npx bool link --project <id>
```

This writes three files:
- **`bool.config.json`** — Project metadata (commit this)
- **`.env.bool`** — Admin data key (add to `.gitignore`, keep secret)
- **`bool/types.d.ts`** — TypeScript types for your data (auto-updated)

### 2. Create Your Client

In your app (Node, Vite, whatever), import the config and create the SDK client:

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

export const supabase = bool.db; // raw Supabase if needed
export const auth = bool.auth;
```

### 3. Define Your Data Model

Create a JSON Schema file for each table:

**`bool/entities/tasks.json`:**
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "title": { "type": "string" },
    "done": { "type": "boolean" },
    "user_id": { "type": "string" },
    "created_at": { "type": "string", "format": "date-time" }
  },
  "required": ["id", "title", "done", "user_id", "created_at"]
}
```

Push it to your project:

```bash
npx bool entities push --dir bool/entities
```

The platform generates a migration, applies it to your schema, and enables Row-Level Security.

### 4. Use Your Data

```ts
// List (sorted, paginated)
const tasks = await bool.entities.tasks.list("-created_at");

// Filter (MongoDB-style operators)
const active = await bool.entities.tasks.filter({ done: false, count: { $gte: 5 } });

// Get one
const task = await bool.entities.tasks.get(id);

// Create
const newTask = await bool.entities.tasks.create({
  title: "Build the thing",
  done: false,
  user_id: userId,
});

// Update
await bool.entities.tasks.update(id, { done: true });

// Delete
await bool.entities.tasks.delete(id);

// Bulk operations
await bool.entities.tasks.bulkCreate([...]);
await bool.entities.tasks.updateMany({ done: false }, { $set: { done: true } });
```

All queries are type-safe via `bool/types.d.ts`.

### 5. Add Authentication

Use the Bool auth layer for signup, signin, and password reset:

```ts
// Sign up
const { user, session } = await bool.auth.signUp({
  email: "user@example.com",
  password: "secret",
});

// Sign in
const { user, session } = await bool.auth.signInWithPassword({
  email: "user@example.com",
  password: "secret",
});

// Get current user
const { data: { user } } = await bool.auth.getUser();

// Sign out
await bool.auth.signOut();

// Listen to auth changes
bool.auth.onAuthStateChange((event, session) => {
  console.log("Auth changed:", event);
});
```

In React, use the auth layer:

```tsx
import { BoolAuthProvider, AuthGate, useBoolAuth } from "bool-sdk/react";

export default function App() {
  return (
    <BoolAuthProvider>
      <AuthGate fallback={<SignInForm />}>
        <Dashboard />
      </AuthGate>
    </BoolAuthProvider>
  );
}

function Dashboard() {
  const { user, signOut } = useBoolAuth();
  return (
    <div>
      <p>Logged in as {user.email}</p>
      <button onClick={signOut}>Sign out</button>
    </div>
  );
}
```

### 6. Deploy

When you're ready to go live:

```bash
npx bool deploy
```

This:
1. Zips your source and `bool/entities/` schemas
2. Uploads to Bool
3. Polls for status
4. Live at `https://<slug>.bool.so`

## Use Cases

### Static Site + Backend

You're building a portfolio site with a contact form. Use Bool for data storage and email.

```ts
// API handler (Remix, Next, etc.)
export async function handleContactForm(formData) {
  const contact = await bool.entities.contacts.create({
    email: formData.email,
    message: formData.message,
    user_id: getCurrentUserId(),
  });
  
  // Email integration via Zapier/webhook
  await sendEmail(contact);
  
  return { success: true };
}
```

**Deployment**: Push your site + schemas. Bool handles the database.

---

### SaaS with Multi-Tenant Data

Your app is a task manager for teams. Each user sees only their team's tasks via RLS.

```ts
// Your schema enforces ownership
// tasks table: user_id (owner field → RLS isolation)

const myTasks = await bool.entities.tasks.list(); // only my tasks
const otherUsersTasks = await bool.entities.tasks.filter({ user_id: "not-me" }); // empty
```

**Deployment**: Same `bool deploy`. Bool's RLS automatically isolates per user.

---

### Real-Time Collaborative App

Building a Figma-like editor? Use Realtime to sync across clients.

```ts
// Subscribe to changes
const unsubscribe = bool.subscribeToChanges("drawings", (change) => {
  // change = { table: "drawings", op: "INSERT|UPDATE|DELETE" }
  // Refetch the document to get fresh data
  const doc = await bool.entities.drawings.get(docId);
  redraw(doc);
});
```

**Deployment**: No special config. Realtime channels are built-in.

---

### Admin Dashboard for Your Service

You offer a service (API, SaaS, whatever) and need an internal dashboard.

```ts
// Your admin schema
// customers table: account status, billing, usage
// logs table: API calls, errors, performance

const customers = await bool.entities.customers.list();
const recentErrors = await bool.entities.logs.filter({ level: "error", count: { $gte: 100 } });
```

Admin key gives you full read/write access during development:

```ts
const newCustomer = await bool.entities.customers.create({
  name: "Acme Corp",
  status: "active",
  user_id: "admin-user-id",
  // ^ required on private tables when using admin key (no end-user identity)
});
```

**Deployment**: Ship it. Users sign in, see their data, you see everything in the admin section.

---

### Rapid Prototyping

Idea validation, hackathons, proof-of-concept.

```bash
# Day 1: link project, define schema, basic CRUD
npx bool link --project <id>
npx bool entities push --dir bool/entities

# Day 2: add auth, realtime updates
# Day 3: deploy and share the URL
npx bool deploy
```

No infrastructure setup. No database to manage. No vendor lock-in (your schema is yours).

---

## Workflows

### Start from Scratch

1. Create a Bool project in the Bool editor
2. `npx bool link --project <id>` in your local app
3. Define entities in `bool/entities/`
4. `npx bool entities push`
5. Code your app

Your schema lives both locally (source) and on the platform (active DB).

### Start in the Editor, Sync to Local

1. Design your schema in the Bool visual editor
2. `npx bool entities pull` in your local folder
3. See the generated `bool/types.d.ts`
4. Continue editing locally or in the editor (they stay in sync)

### Iterate Locally, Test on Preview

1. `npx bool entities push` to update the live schema
2. The platform rebuilds your app on a preview URL
3. Share the link for feedback
4. When ready: `npx bool deploy` to production

### Publish from CI/CD

```yaml
# GitHub Actions example
- run: npx bool deploy --token ${{ secrets.BOOL_TOKEN }}
```

Your app deploys on every push to main (or manually via workflow dispatch).

---

## Private vs. Public Entities

### Private (Default)

Rows belong to a user. RLS enforces owner isolation.

```json
// bool/entities/tasks.json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "user_id": { "type": "string" },
    "title": { "type": "string" }
  },
  "required": ["id", "user_id", "title"],
  "x-private": true  // optional: makes intent explicit
}
```

**End-user client:**
```ts
const tasks = await bool.entities.tasks.list(); // only mine
```

**Admin client (with apiKey):**
```ts
// Must provide user_id explicitly (admin has no user identity)
await bool.entities.tasks.create({
  title: "Task for someone",
  user_id: "user-id-here",
});
```

### Public

Open read/write with optional RLS policies.

```json
// bool/entities/comments.json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "text": { "type": "string" },
    "post_id": { "type": "string" }
  },
  "required": ["id", "text", "post_id"],
  "x-private": false
}
```

Anyone (end-user or public) can read/write, subject to RLS.

---

## Tips & Gotchas

### Admin Key Only Works During Development

The admin key (`apiKey`) is your personal development credential. Treat it like a password:

- ✅ Use in local scripts and CI/CD
- ❌ Don't ship it in client code
- ❌ Don't commit `.env.bool` to git

When your app is deployed, end-users authenticate via Bool Auth (no admin key).

### Private Entities Need `user_id` on Admin Create

When you use the admin key and create a row on a private entity, Bool can't default `user_id` (you have no user identity). You must pass it:

```ts
// ❌ Fails with NOT NULL violation
await bool.entities.tasks.create({ title: "Task" });

// ✅ Works
await bool.entities.tasks.create({ title: "Task", user_id: "uid" });
```

### Filters & Operators

Entity filters use MongoDB-style syntax:

```ts
// Comparison
{ status: "active" }                   // $eq (default)
{ count: { $gt: 10 } }                 // $gt, $gte, $lt, $lte
{ id: { $in: ["a", "b"] } }           // $in, $nin
{ email: { $regex: "^admin" } }       // $regex

// Logic
{ $and: [{...}, {...}] }               // AND
{ $or: [{...}, {...}] }                // OR

// Existence
{ deleted_at: { $exists: false } }    // $exists
```

### Pagination

Lists are paginated (50 rows by default, max 5000):

```ts
const page1 = await bool.entities.tasks.list("-created_at", { limit: 50, skip: 0 });
const page2 = await bool.entities.tasks.list("-created_at", { limit: 50, skip: 50 });

// Or filter to get all matching
const all = await bool.entities.tasks.filter({ status: "active" }, { limit: 5000 });
```

### Sorting

Sort by column name, prefix with `-` for descending:

```ts
bool.entities.tasks.list("-created_at");  // newest first
bool.entities.tasks.list("title");         // A-Z
```

### Realtime Only Broadcasts Pings

Subscriptions send `{table, op}` pings — never row data. Always refetch on ping:

```ts
bool.subscribeToChanges("tasks", async (change) => {
  const updated = await bool.entities.tasks.get(taskId);
  updateUI(updated);
});
```

---

## Troubleshooting

### `bool link` Fails with "Not found"

- Check project ID (copy from Bool editor)
- Verify token: `echo $BOOL_TOKEN`
- Token must be owner-level (Admin → Settings → Access tokens)

### Deploy Fails with 401

- Refresh your token: `npx bool link --project <id>`
- `.env.bool` may be outdated

### Types Not Updating

```bash
npx bool types
```

This refreshes `bool/types.d.ts` from the server.

### Data Not Appearing

- Verify user is logged in: `await bool.auth.getUser()`
- Check RLS: private entities filter by current user
- Admin key bypasses RLS, so admin reads/writes always work

---

## Next Steps

- [Deployment guide](./DEPLOYMENT.md) — publishing and going live
- [Data modeling](./DATA-MODELING.md) — schema patterns and best practices
- [React integration](./REACT.md) — hooks and components
- [API reference](../README.md#Usage) — all SDK methods
