# FAQ — Common Questions

## Getting Started

### What's the difference between Bool apps and local development?

**Bool apps** — designed in the Bool visual editor, edited/deployed on the platform.

**Local development** — develop on your machine with your own tools, publish to Bool hosting.

Both use the same backend (data, auth, AI). The difference is *where* you edit the UI.

### Do I need to know SQL?

No. You define tables as JSON Schema, and the Bool SDK handles queries.

```ts
// Not this:
const result = await db.query('SELECT * FROM tasks WHERE user_id = $1');

// This:
const tasks = await bool.entities.tasks.list();
```

### Can I use my own database?

No. Bool provides the database (Postgres) as part of your project. The schema is append-only (additive migrations only), so you can't break production data.

### What happens to my data if I delete the project?

Data is archived for 30 days, then permanently deleted. Export before deleting if you need it.

---

## Development

### Can I develop offline?

Not fully. You need to run `bool link --project <id>` at least once (online) to get credentials. After that, you can code offline, but you won't be able to:
- Push schema changes
- Deploy
- Fetch updated types

### How do I handle schema changes?

1. Edit `bool/entities/*.json`
2. `npx bool entities push`
3. Bool generates a migration, applies it to your database
4. Your app's TypeScript types auto-update

Migrations are **additive only** (ADD COLUMN, never DROP). You can't remove fields mid-flight.

### Can I test locally without deploying?

Yes. Run your app locally with `npm run dev`. The Bool SDK connects to your real project (via connection config), so you're testing against live data.

```bash
# Local dev with live data
npm run dev

# See your data
await bool.entities.tasks.list()  // returns real rows from Bool
```

### How do I seed initial data?

Use the admin key during development:

```ts
import { createBoolClient } from "bool-sdk";
import config from "./bool.config.json";

const bool = createBoolClient({
  // ... config
  apiKey: process.env.BOOL_API_KEY,
});

async function seedData() {
  await bool.entities.categories.bulkCreate([
    { id: "cat1", name: "Work" },
    { id: "cat2", name: "Personal" },
  ]);
}

seedData();
```

The admin key bypasses RLS, so you can create data with any `user_id` you want.

---

## Authentication & Authorization

### How does Bool Auth work?

Each Bool project gets its own isolated auth system:

1. Users sign up via `bool.auth.signUp()`
2. Bool issues a session token (JWT)
3. SDK includes token on all requests
4. Gateway validates token server-side
5. RLS policies enforce access rules

Users are isolated per project. Signing up in one app doesn't create an account in another.

### Can I use my own auth provider?

You could, but you'd need to:
1. Disable Bool Auth
2. Implement your own token generation
3. Pass it to the SDK manually

Not officially supported. Most users just use Bool Auth (it's free).

### How does RLS work?

Row-Level Security is a Postgres feature that filters rows based on the current user:

```sql
-- For private entities (user_id owner field):
WHERE user_id = auth.uid()
```

When you create a private entity:

```json
{ "x-private": true, "properties": { "user_id": {...} } }
```

Bool enables RLS and creates this policy automatically. End-users only see their rows.

### What if I want shared data?

Use public entities:

```json
{ "x-private": false, "properties": { ... } }
```

Everyone can read/write (no RLS filter). You can add policies if needed (e.g., only admins can create).

---

## Data & Queries

### How do I sort results?

Pass a sort string (field name, prefix with `-` for descending):

```ts
bool.entities.tasks.list("-created_at");  // newest first
bool.entities.tasks.list("title");         // A-Z
```

### How do I filter by multiple conditions?

Use MongoDB-style operators:

```ts
// Tasks that are done AND high priority
await bool.entities.tasks.filter({
  done: true,
  priority: "high",
});

// Tasks where count > 5 AND status is "active"
await bool.entities.tasks.filter({
  count: { $gte: 5 },
  status: "active",
});

// Tasks where title contains "bug" OR status is "error"
await bool.entities.tasks.filter({
  $or: [
    { title: { $regex: "bug" } },
    { status: "error" },
  ],
});
```

### How do I paginate results?

Lists are paginated (50 rows default, max 5000):

```ts
const page1 = await bool.entities.tasks.list(undefined, { limit: 50, skip: 0 });
const page2 = await bool.entities.tasks.list(undefined, { limit: 50, skip: 50 });
```

Or use `filter()` for larger result sets:

```ts
const all = await bool.entities.tasks.filter({ status: "active" }, { limit: 5000 });
```

### How do I do a JOIN?

There's no JOIN operator. Instead:

```ts
// Get a post
const post = await bool.entities.posts.get(postId);

// Get the author
const author = await bool.entities.users.get(post.author_id);
```

Or filter by foreign key:

```ts
// Get all comments on a post
const comments = await bool.entities.comments.filter({
  post_id: postId,
});
```

For many-to-many (tags on posts), create a junction table:

```ts
// Get tags on a post
const postTags = await bool.entities.post_tags.filter({ post_id: postId });
const tags = await Promise.all(
  postTags.map((pt) => bool.entities.tags.get(pt.tag_id))
);
```

### How do I count results?

```ts
const all = await bool.entities.tasks.filter({ done: false });
console.log(all.length);
```

Or estimate (depends on DB stats):

```ts
const count = await bool.db.from("tasks").select("*", { count: "estimated" });
console.log(count.count);
```

### How do I update multiple rows at once?

```ts
// Mark all tasks as done
await bool.entities.tasks.updateMany(
  { done: false },           // filter
  { $set: { done: true } }   // update
);

// Increment view count on all posts
await bool.entities.posts.updateMany(
  { user_id: userId },
  { $set: { views: 0 } }  // note: updateMany doesn't do increment yet
);
```

### How do I delete multiple rows?

```ts
// Delete all completed tasks
await bool.entities.tasks.deleteMany({ done: true });
```

---

## Realtime & Subscriptions

### How do Realtime updates work?

The Bool SDK doesn't give you the full row data in the notification (for performance). Instead, you get a ping:

```ts
bool.subscribeToChanges("tasks", (change) => {
  // change = { table: "tasks", op: "INSERT|UPDATE|DELETE" }
  // Refetch to get fresh data
  const updated = await bool.entities.tasks.get(taskId);
});
```

This is by design: pings are cheap, refetch is explicit.

### Can I filter Realtime notifications?

Not yet. Subscriptions notify on any change to the table. You refetch and filter in code:

```ts
bool.subscribeToChanges("tasks", async (change) => {
  if (change.op === "INSERT" || change.op === "UPDATE") {
    const task = await bool.entities.tasks.get(taskId);
    if (task.done) {
      // Handle completed task
    }
  }
});
```

### How do I unsubscribe?

```ts
const unsubscribe = bool.subscribeToChanges("tasks", handler);

// Later...
unsubscribe();
```

---

## Deployment

### How long does it take to deploy?

Usually 1–2 minutes. Includes:
- Zipping your source
- Uploading to S3
- Building on Vercel Sandbox
- Testing
- Going live

### Can I deploy from CI/CD?

Yes. Add `BOOL_TOKEN` as a secret and run:

```bash
npx bool deploy --token ${{ secrets.BOOL_TOKEN }}
```

### What if I deploy a broken version?

Redeploy the previous commit. Your old version stays live until the new one is ready.

```bash
git checkout HEAD~1
npx bool deploy
```

Or use the Bool dashboard to roll back.

### Can I have staging and production?

Create two Bool projects:
- `my-app-staging` — dev previews
- `my-app-prod` — production

Deploy to staging first, test, then promote.

Or use different branches in CI/CD:

```yaml
on:
  push:
    branches:
      - main        # deploys to prod
      - staging     # deploys to staging
```

### What's the 65 KB limit?

Your entire app (source + schemas + config) must be < 65 KB compressed. This forces efficiency:

- ✅ Minified JavaScript
- ✅ Tree-shaken dependencies
- ✅ No node_modules in the zip
- ❌ Large media assets (use a CDN instead)

Most apps (React + schemas) are 20–40 KB.

---

## Performance & Limits

### What are the query limits?

- **Lists**: 50 rows by default, 5000 max per call
- **Filters**: 5000 rows max per call
- **Bulk operations**: 1000 rows per call
- **Realtime**: no hard limit (depends on Postgres capacity)

For larger datasets, paginate:

```ts
const all = [];
for (let skip = 0; skip < total; skip += 5000) {
  const batch = await bool.entities.tasks.filter({...}, { limit: 5000, skip });
  all.push(...batch);
}
```

### How do I optimize slow queries?

1. **Add indexes**: RLS and `user_id` are indexed by default
2. **Filter early**: filter before sorting/pagination
3. **Use specific fields**: don't fetch everything if you only need a few columns
4. **Paginate**: avoid fetching 10K rows at once

For complex queries, you might need a database view or a custom API route.

### What about N+1 queries?

The SDK doesn't batch queries. If you fetch 100 posts and then their authors:

```ts
const posts = await bool.entities.posts.list();
const authors = await Promise.all(
  posts.map(p => bool.entities.users.get(p.author_id))
);
```

This is 101 queries (1 + 100). For small datasets, it's fine. For large datasets, consider:

1. **Denormalize**: store `author_name` on the post
2. **Batch fetch**: write a custom query if you need optimization
3. **Junction tables**: reduce the number of separate fetches

---

## Billing & Costs

### Is Bool free?

Bool offers a free tier with limitations. Paid tiers unlock:
- Higher limits
- More storage
- Premium support
- Custom domains

### Do I pay per API call?

No. You pay for project capacity, not per request. Use as much as you want within your tier.

### What about AI credits?

AI calls are metered separately. Bool includes AI credits in paid plans. Free tier has limited AI.

---

## Security

### Is my data private?

Yes. RLS enforces row-level isolation. End-users only see their own rows.

### Can I encrypt fields?

Not natively. You can:
1. Encrypt before sending: `await bool.entities.tasks.create({ secret: encrypt(data) })`
2. Decrypt when reading: `decrypt(task.secret)`

Or use a custom database view with pgcrypto.

### Is data backed up?

Yes. Bool backs up daily. You can request a backup via support.

### Can I export my data?

Yes. Use the Bool dashboard to export schemas/data, or query via the SDK and save locally.

---

## Troubleshooting

### "Invalid project" error

- Check project ID (copy from Bool editor)
- Verify you own the project (or have access)
- Run `npx bool link --project <id>` again

### "Unauthorized" on deploy

- Refresh your token: `npx bool link --project <id>`
- Check `.env.bool` is still present and readable
- Verify `BOOL_TOKEN` env var is set

### Types out of sync

```bash
npx bool types
```

This refreshes `bool/types.d.ts` from the server.

### Data not appearing

1. Check user is authenticated: `const user = await bool.auth.getUser()`
2. For private entities, verify `user_id` matches current user
3. Check RLS policies: in the Bool dashboard, view table details
4. Try refetching: `const fresh = await bool.entities.tasks.list()`

### Realtime not working

- Verify subscription is active: `const unsubscribe = bool.subscribeToChanges(...)`
- Check browser console for errors
- Realtime needs WebSocket support (most modern browsers have it)

---

## More Help

- [Local Development Guide](./LOCAL-DEVELOPMENT.md)
- [Deployment Guide](./DEPLOYMENT.md)
- [Data Modeling](./DATA-MODELING.md)
- [Examples](../examples/)
- [API Reference](../README.md)
