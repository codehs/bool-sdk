# Bool SDK Documentation

Welcome to Bool. Build your app on your machine, publish to Bool hosting, no infrastructure required.

## Quickstart (5 min)

```bash
npm install bool-sdk
export BOOL_TOKEN=bool_live_xxxxx  # from Bool → Settings

npx bool link --project <id>       # connect to your project
npm run dev                         # develop locally
npx bool deploy                    # publish when ready
```

Your app is live at `https://<slug>.bool.so`.

---

## Guides

### [Local Development](./LOCAL-DEVELOPMENT.md)
**Your complete guide to building apps locally.** Covers linking a project, defining schemas, using the SDK, and different workflows.

- **Link your project** — set up config, types, and credentials
- **Define data models** — create tables with JSON Schema
- **Use the SDK** — CRUD operations, auth, realtime, AI
- **Different workflows** — start from scratch, sync with editor, iterate locally
- **Use cases** — static sites, SaaS, real-time apps, admin dashboards, prototyping
- **Tips & gotchas** — admin key behavior, private entities, filters, pagination

**Read this first.** It walks you through building your first app, step by step.

---

### [Deployment](./DEPLOYMENT.md)
**Publish your app to production and beyond.**

- **How publishing works** — what happens when you deploy
- **Quick deploy** — one command to go live
- **CI/CD** — GitHub Actions and automation
- **Monitoring** — check build logs and app health
- **Troubleshooting** — common deploy issues and fixes

**Read this when you're ready to ship.**

---

### [Data Modeling](./DATA-MODELING.md)
**Design your database schema for privacy, performance, and maintainability.**

- **Field types** — supported types and constraints
- **Privacy** — private (owner-isolated) vs. public (open) entities
- **Common patterns** — timestamps, ownership, soft deletes, status enums, nesting, relationships
- **Schema evolution** — adding/removing/renaming fields safely
- **Design tips** — keep it simple, use enums, denormalize, archive instead of delete
- **Real-world examples** — blog, task manager, e-commerce schemas

**Read this to understand how to structure your data.**

---

### [FAQ](./FAQ.md)
**Common questions and answers.**

- **Getting started** — what's the difference between Bool apps and local dev, do I need SQL?
- **Development** — offline development, schema changes, testing, seeding data
- **Auth** — how Bool Auth works, RLS, private vs. public data
- **Queries** — sorting, filtering, pagination, joins, counts, bulk operations
- **Realtime** — subscriptions, filtering, unsubscribing
- **Deployment** — build times, CI/CD, staging/prod, the 65 KB limit
- **Performance** — query limits, optimization, N+1 queries
- **Troubleshooting** — errors and how to fix them

**Read this when you have a specific question.**

---

## Examples

These are complete, runnable examples of real apps:

### [Todo App (React)](../examples/todo-app-react.md)
A task manager with signup, task CRUD, and realtime updates.

**Shows:**
- React integration with `BoolAuthProvider`
- Private entities (user-owned tasks)
- Create, read, update, delete operations
- Realtime subscriptions and refetching

---

### [Blog with CMS](../examples/blog-with-cms.md)
A published blog with public pages and an admin dashboard.

**Shows:**
- Public entities (published posts, comments)
- Filtering (published posts only)
- Admin-only pages
- Comment moderation flow

---

## API Reference

See the [main README](../README.md#Usage) for full SDK API documentation.

**Quick links:**
- **Entity methods** — `list()`, `filter()`, `get()`, `create()`, `bulkCreate()`, `update()`, `bulkUpdate()`, `updateMany()`, `delete()`, `deleteMany()`
- **Auth methods** — `signUp()`, `signInWithPassword()`, `signOut()`, `getUser()`, `onAuthStateChange()`, password reset
- **AI methods** — `generate()`, `stream()` with schema support
- **Realtime** — `subscribeToChanges()`
- **Raw access** — `client.db` for Supabase REST queries

---

## Key Concepts

### Projects
A Bool project is your app's backend. It includes:
- A Postgres database with your schema
- User accounts (Bool Auth)
- File storage
- AI credits

Create a project in the Bool editor, then connect locally with `bool link --project <id>`.

### Entities (Tables)
Entities are JSON Schema files that define your database tables. Commit them to git.

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "title": { "type": "string" },
    "done": { "type": "boolean" }
  },
  "required": ["id", "title", "done"]
}
```

Push changes: `npx bool entities push --dir bool/entities`.

### Admin Key
The personal API key (`apiKey` parameter) lets you bypass RLS during development. Treat it like a password:
- ✅ Use in local code and CI/CD
- ❌ Never ship it in client bundles
- ❌ Never commit `.env.bool` to git

### RLS (Row-Level Security)
Postgres feature that automatically filters rows based on the current user. For private entities (with `user_id`), RLS enforces owner isolation:

```ts
// End-user: sees only their rows
await bool.entities.tasks.list();  // returns tasks where user_id == current_user
```

### Realtime
Postgres notifies clients of changes via WebSocket. The SDK doesn't send full row data (for performance) — instead, you get pings and refetch:

```ts
bool.subscribeToChanges("tasks", async (change) => {
  const updated = await bool.entities.tasks.get(taskId);
});
```

---

## Stack

The Bool SDK uses:
- **Supabase** — Postgres, Auth, Realtime, Storage
- **Gateway** — Bool's request router (your SDK calls go through here)
- **Vercel Sandbox** — builds and runs your deployed app
- **Zero deps** — SDK has no runtime dependencies (just Supabase client in peerDeps)

---

## Next Steps

1. **New to Bool?** Start with [Local Development](./LOCAL-DEVELOPMENT.md)
2. **Building your app?** Check [Data Modeling](./DATA-MODELING.md) for schema patterns
3. **Ready to ship?** Read [Deployment](./DEPLOYMENT.md)
4. **Have a question?** Search [FAQ](./FAQ.md)
5. **Want to see examples?** Check [Examples](../examples/)

---

## Support

- 📖 [Documentation](.) — you're reading it
- 💬 [Discussions](https://github.com/codehs/bool-sdk/discussions)
- 🐛 [Issues](https://github.com/codehs/bool-sdk/issues)
- 💌 [Email](mailto:hello@bool.so)
