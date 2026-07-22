# Data Modeling — Designing Your Schema

How to structure your entities (tables) for privacy, performance, and maintainability.

## Entity Basics

Each entity is a JSON Schema file in `bool/entities/`:

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "name": { "type": "string" },
    "created_at": { "type": "string", "format": "date-time" }
  },
  "required": ["id", "name", "created_at"]
}
```

After `bool entities push`, Bool creates a Postgres table with RLS enabled.

## Field Types

Bool supports a JSON Schema subset:

| Type | Example | Notes |
|------|---------|-------|
| `string` | `{ "type": "string" }` | VARCHAR |
| `integer` | `{ "type": "integer" }` | INT, with `minimum` / `maximum` |
| `number` | `{ "type": "number" }` | FLOAT / DECIMAL |
| `boolean` | `{ "type": "boolean" }` | BOOLEAN |
| `object` | `{ "type": "object", "properties": {...} }` | JSONB (nested data) |
| `array` | `{ "type": "array", "items": {...} }` | Array / JSONB |

**With format constraints:**

```json
{
  "email": { "type": "string", "format": "email" },
  "url": { "type": "string", "format": "uri" },
  "date": { "type": "string", "format": "date" },
  "datetime": { "type": "string", "format": "date-time" },
  "uuid": { "type": "string", "format": "uuid" }
}
```

**With value constraints:**

```json
{
  "age": { "type": "integer", "minimum": 0, "maximum": 150 },
  "name": { "type": "string", "minLength": 1, "maxLength": 100 },
  "priority": { "type": "integer", "enum": [1, 2, 3, 4, 5] }
}
```

## Privacy: Private vs. Public

### Private Entity (Default)

Data belongs to a user. Only the owner can read/write their rows.

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "user_id": { "type": "string" },
    "title": { "type": "string" },
    "content": { "type": "string" }
  },
  "required": ["id", "user_id", "title"],
  "x-private": true
}
```

**SDK behavior:**

```ts
// End-user client (no apiKey)
const posts = await bool.entities.posts.list();
// Returns: only posts where user_id == current_user

// Admin client (with apiKey)
const allPosts = await bool.entities.posts.filter({ user_id: "any-user" });
// Returns: any posts (no filter applied)
```

**Use for:**
- User-owned data: posts, tasks, comments, preferences
- Sensitive data: billing, personal info
- SaaS data: customer accounts, project resources

### Public Entity

Anyone (authenticated or not) can read/write, subject to RLS policies.

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "title": { "type": "string" },
    "views": { "type": "integer" }
  },
  "required": ["id", "title"],
  "x-private": false
}
```

**SDK behavior:**

```ts
// Any client can read
const articles = await bool.entities.articles.list();

// RLS policies may still restrict writes
// (e.g., only admins can create, anyone can comment)
```

**Use for:**
- Published content: blog posts, product listings, documentation
- Shared read-only data: categories, tags, metadata
- Community data: comments, reviews (with ownership tracking)

## Common Patterns

### Timestamps (Automatic)

Always include created/updated timestamps:

```json
{
  "id": { "type": "string" },
  "title": { "type": "string" },
  "created_at": { "type": "string", "format": "date-time" },
  "updated_at": { "type": "string", "format": "date-time" }
}
```

When creating:
```ts
await bool.entities.posts.create({
  title: "Hello",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});
```

Or use a helper:
```ts
const now = new Date().toISOString();
const post = await bool.entities.posts.create({
  title: "Hello",
  created_at: now,
  updated_at: now,
});
```

### Ownership (user_id, team_id)

For private data, always track the owner:

```json
{
  "id": { "type": "string" },
  "user_id": { "type": "string" },
  "title": { "type": "string" }
}
```

```ts
const userId = (await bool.auth.getUser()).user.id;
await bool.entities.posts.create({
  title: "My post",
  user_id: userId,
});
```

RLS automatically filters to `user_id == current_user`.

### Soft Deletes

Instead of deleting, mark as deleted:

```json
{
  "id": { "type": "string" },
  "title": { "type": "string" },
  "deleted_at": { "type": ["string", "null"], "format": "date-time" }
}
```

```ts
// "Delete" (set deleted_at)
await bool.entities.posts.update(postId, {
  deleted_at: new Date().toISOString(),
});

// Query active posts
const active = await bool.entities.posts.filter({
  deleted_at: { $exists: false },
});

// Query deleted posts
const trash = await bool.entities.posts.filter({
  deleted_at: { $exists: true },
});
```

### Status Enums

```json
{
  "id": { "type": "string" },
  "status": {
    "type": "string",
    "enum": ["draft", "published", "archived"]
  }
}
```

```ts
const published = await bool.entities.posts.filter({
  status: "published",
});
```

### Nested Data (JSONB)

Store structured data without creating a separate table:

```json
{
  "id": { "type": "string" },
  "title": { "type": "string" },
  "metadata": {
    "type": "object",
    "properties": {
      "tags": { "type": "array", "items": { "type": "string" } },
      "color": { "type": "string" },
      "stats": {
        "type": "object",
        "properties": {
          "views": { "type": "integer" },
          "likes": { "type": "integer" }
        }
      }
    }
  }
}
```

```ts
await bool.entities.posts.create({
  title: "Hello",
  metadata: {
    tags: ["javascript", "react"],
    color: "#ff0000",
    stats: { views: 0, likes: 0 },
  },
});

// Update nested field
await bool.entities.posts.update(postId, {
  metadata: {
    ...old.metadata,
    stats: { ...old.metadata.stats, views: old.metadata.stats.views + 1 },
  },
});
```

### Relationships (Foreign Keys)

For belongs-to relationships:

```json
{
  "id": { "type": "string" },
  "title": { "type": "string" },
  "author_id": { "type": "string" }
}
```

Then fetch the related row:

```ts
const post = await bool.entities.posts.get(postId);
const author = await bool.entities.users.get(post.author_id);
```

Or filter by relationship:

```ts
const userPosts = await bool.entities.posts.filter({
  author_id: userId,
});
```

For many-to-many (tags on posts), use a junction table:

```json
// bool/entities/post_tags.json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "post_id": { "type": "string" },
    "tag_id": { "type": "string" }
  },
  "required": ["id", "post_id", "tag_id"]
}
```

```ts
// Add a tag to a post
await bool.entities.post_tags.create({
  post_id: postId,
  tag_id: tagId,
});

// Get tags for a post
const tags = await bool.entities.post_tags.filter({ post_id: postId });
const tagIds = tags.map(t => t.tag_id);
const tagNames = await Promise.all(
  tagIds.map(id => bool.entities.tags.get(id))
);
```

## Schema Evolution

### Adding Fields (Always Safe)

```json
// Original
{ "type": "string", "properties": { "id": {...}, "title": {...} } }

// Add a new field
{ "type": "string", "properties": { "id": {...}, "title": {...}, "subtitle": {...} } }
```

`bool entities push` generates a migration that adds the column. Existing rows get NULL (or a default if you specify one).

### Removing Fields

Removing a field breaks existing apps. Instead:

1. Mark as deprecated in your schema comments
2. Clients stop reading it
3. After 3+ deploys, remove it

Or use soft-delete pattern (add `deprecated: true` to the schema).

### Renaming Fields

Can't rename directly (breaks migrations). Instead:

1. Add new field: `new_name`
2. Write new data to both `old_name` and `new_name`
3. Migrate existing data: `UPDATE table SET new_name = old_name WHERE new_name IS NULL`
4. Once all rows updated, remove `old_name` (safe)

### Changing Types

Changing `string` to `integer` breaks existing data. Instead:

1. Add new field: `count_int` (integer type)
2. Write new data to both fields
3. Migrate: `UPDATE table SET count_int = CAST(count_str AS INTEGER)`
4. Remove `count_str` once migrated

## Design Tips

### Keep It Simple

Start with just the fields you need. Add fields later as needed. Smaller schema = faster migrations.

**Good:**
```json
{
  "id": { "type": "string" },
  "title": { "type": "string" },
  "user_id": { "type": "string" }
}
```

**Avoid:**
```json
{
  "id": { "type": "string" },
  "title": { "type": "string" },
  "user_id": { "type": "string" },
  "old_user_id": { "type": ["string", "null"] },
  "reserved1": { "type": ["string", "null"] },
  "reserved2": { "type": ["string", "null"] },
  ...
}
```

### Use Enums for Status

Instead of free-form strings, use enums to prevent typos and enable filtering:

```json
{
  "status": {
    "type": "string",
    "enum": ["pending", "active", "completed"]
  }
}
```

### Denormalize for Performance

Avoid complex joins. If you frequently need denormalized data, store it:

```json
{
  "id": { "type": "string" },
  "post_id": { "type": "string" },
  "author_id": { "type": "string" },
  "author_name": { "type": "string" },
  "created_at": { "type": "string", "format": "date-time" }
}
```

When creating, look up `author_name`:

```ts
const author = await bool.entities.users.get(authorId);
const comment = await bool.entities.comments.create({
  post_id: postId,
  author_id: author.id,
  author_name: author.name,
  created_at: new Date().toISOString(),
});
```

On update, keep both in sync:

```ts
await bool.entities.comments.update(commentId, {
  author_name: newAuthorName,
});
```

### Archive Instead of Delete

For audit trails and data recovery:

```json
{
  "id": { "type": "string" },
  "deleted_at": { "type": ["string", "null"] },
  "deleted_by": { "type": ["string", "null"] }
}
```

---

## Examples

### Blog

```
users
  - id, email, name, created_at

posts (private: user_id)
  - id, user_id, title, content, published, created_at, updated_at

comments (private: user_id, foreign key: post_id)
  - id, user_id, post_id, content, created_at

tags (public)
  - id, name, slug

post_tags (junction)
  - id, post_id, tag_id
```

### Task Manager

```
teams (private: user_id)
  - id, user_id, name

team_members
  - id, team_id, user_id, role

projects (private: team_id)
  - id, team_id, name

tasks (private: team_id, foreign key: project_id)
  - id, team_id, project_id, title, done, priority, created_at
```

### E-Commerce

```
users (private)
  - id, email, name

products (public)
  - id, name, price, stock

cart (private: user_id, foreign key: product_id)
  - id, user_id, product_id, quantity

orders (private: user_id)
  - id, user_id, total, status, created_at

order_items (private: user_id, foreign key: order_id, product_id)
  - id, user_id, order_id, product_id, quantity, price
```

---

## Next Steps

- [Local development](./LOCAL-DEVELOPMENT.md) — building your app
- [Deployment](./DEPLOYMENT.md) — publishing to production
