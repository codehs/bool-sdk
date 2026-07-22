# Example: Blog with CMS (Static + Admin)

A published blog (public pages) with an admin dashboard for content management.

## Project Structure

```
my-blog/
  bool/
    entities/
      posts.json
      comments.json
  src/
    pages/
      index.tsx          # blog home
      blog/
        [slug].tsx       # blog post page
    app/
      admin/
        page.tsx         # admin dashboard (protected)
    components/
      BlogHeader.tsx
      PostCard.tsx
```

## 1. Schema

**`bool/entities/posts.json`:**
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "slug": { "type": "string" },
    "title": { "type": "string" },
    "excerpt": { "type": "string" },
    "content": { "type": "string" },
    "author": { "type": "string" },
    "published": { "type": "boolean" },
    "published_at": { "type": ["string", "null"], "format": "date-time" },
    "created_at": { "type": "string", "format": "date-time" },
    "updated_at": { "type": "string", "format": "date-time" }
  },
  "required": ["id", "slug", "title", "content", "author", "published", "created_at"],
  "x-private": false
}
```

**`bool/entities/comments.json`:**
```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "post_id": { "type": "string" },
    "author": { "type": "string" },
    "email": { "type": "string" },
    "content": { "type": "string" },
    "approved": { "type": "boolean" },
    "created_at": { "type": "string", "format": "date-time" }
  },
  "required": ["id", "post_id", "author", "email", "content", "approved", "created_at"],
  "x-private": false
}
```

## 2. Public Blog Pages

**`src/pages/index.tsx`:**
```tsx
import { useEffect, useState } from "react";
import { bool } from "../lib/supabase";
import { PostCard } from "../components/PostCard";

export default function HomePage() {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadPosts = async () => {
      // Only fetch published posts, sorted by date
      const published = await bool.entities.posts.filter(
        { published: true },
        { limit: 100 }
      );
      setPosts(published.sort((a, b) => 
        new Date(b.published_at) - new Date(a.published_at)
      ));
      setLoading(false);
    };
    loadPosts();
  }, []);

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <h1>My Blog</h1>
      <div style={{ display: "grid", gap: 20 }}>
        {posts.map((post) => (
          <PostCard key={post.id} post={post} />
        ))}
      </div>
    </div>
  );
}
```

**`src/pages/blog/[slug].tsx`:**
```tsx
import { useParams, useEffect, useState } from "react";
import { bool } from "../../lib/supabase";

export default function PostPage() {
  const { slug } = useParams();
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadPost = async () => {
      // Fetch the post by slug
      const posts = await bool.entities.posts.filter({ slug });
      if (posts.length > 0) {
        setPost(posts[0]);

        // Fetch approved comments
        const approved = await bool.entities.comments.filter({
          post_id: posts[0].id,
          approved: true,
        });
        setComments(approved);
      }
      setLoading(false);
    };
    loadPost();
  }, [slug]);

  if (loading) return <p>Loading...</p>;
  if (!post) return <p>Post not found</p>;

  return (
    <article style={{ maxWidth: 800, margin: "0 auto", padding: 20 }}>
      <h1>{post.title}</h1>
      <p style={{ color: "#666" }}>
        By {post.author} on{" "}
        {new Date(post.published_at).toLocaleDateString()}
      </p>

      <div style={{ whiteSpace: "pre-wrap" }}>{post.content}</div>

      <section style={{ marginTop: 40 }}>
        <h2>Comments ({comments.length})</h2>
        {comments.map((comment) => (
          <div
            key={comment.id}
            style={{
              border: "1px solid #ddd",
              padding: 10,
              marginBottom: 10,
              borderRadius: 4,
            }}
          >
            <p>
              <strong>{comment.author}</strong>{" "}
              <span style={{ color: "#666" }}>
                {new Date(comment.created_at).toLocaleDateString()}
              </span>
            </p>
            <p>{comment.content}</p>
          </div>
        ))}
      </section>

      <CommentForm postId={post.id} />
    </article>
  );
}

function CommentForm({ postId }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [content, setContent] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!name || !email || !content) return;
    
    // Create comment (unapproved by default)
    await bool.entities.comments.create({
      post_id: postId,
      author: name,
      email,
      content,
      approved: false, // admin reviews first
      created_at: new Date().toISOString(),
    });

    setSubmitted(true);
    setName("");
    setEmail("");
    setContent("");
  };

  if (submitted) {
    return <p>Thanks! Your comment is pending review.</p>;
  }

  return (
    <div style={{ marginTop: 30, padding: 20, border: "1px solid #ddd" }}>
      <h3>Leave a Comment</h3>
      <input
        type="text"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <textarea
        placeholder="Comment"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={4}
      />
      <button onClick={handleSubmit}>Submit</button>
    </div>
  );
}
```

## 3. Admin Dashboard

**`src/pages/admin/index.tsx`:**
```tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBoolAuth } from "bool-sdk/react";
import { bool } from "../../lib/supabase";

export default function AdminDashboard() {
  const { user } = useBoolAuth();
  const navigate = useNavigate();
  const [posts, setPosts] = useState([]);
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      // Only the admin can access this (you'd add proper auth check)
      const allPosts = await bool.entities.posts.list("-created_at");
      setPosts(allPosts);

      const unapproved = await bool.entities.comments.filter({
        approved: false,
      });
      setComments(unapproved);

      setLoading(false);
    };
    loadData();
  }, []);

  if (!user) {
    return <p>Not authenticated</p>;
  }

  if (loading) return <p>Loading...</p>;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 20 }}>
      <h1>Admin Dashboard</h1>

      <section style={{ marginBottom: 40 }}>
        <h2>Posts ({posts.length})</h2>
        <button onClick={() => navigate("/admin/posts/new")}>
          New Post
        </button>
        <table style={{ width: "100%", marginTop: 20 }}>
          <thead>
            <tr>
              <th>Title</th>
              <th>Author</th>
              <th>Published</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {posts.map((post) => (
              <tr key={post.id}>
                <td>{post.title}</td>
                <td>{post.author}</td>
                <td>{post.published ? "Yes" : "No"}</td>
                <td>
                  <button onClick={() => navigate(`/admin/posts/${post.id}`)}>
                    Edit
                  </button>
                  <button onClick={() => deletePost(post.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Pending Comments ({comments.length})</h2>
        {comments.map((comment) => (
          <div
            key={comment.id}
            style={{
              border: "1px solid #ffc107",
              padding: 15,
              marginBottom: 15,
              borderRadius: 4,
            }}
          >
            <p>
              <strong>{comment.author}</strong> on post {comment.post_id}
            </p>
            <p>{comment.content}</p>
            <button
              onClick={() => approveComment(comment.id)}
              style={{ marginRight: 10 }}
            >
              Approve
            </button>
            <button onClick={() => deleteComment(comment.id)}>Delete</button>
          </div>
        ))}
      </section>
    </div>
  );

  async function deletePost(id) {
    if (confirm("Delete this post?")) {
      await bool.entities.posts.delete(id);
      setPosts(posts.filter((p) => p.id !== id));
    }
  }

  async function approveComment(id) {
    await bool.entities.comments.update(id, { approved: true });
    setComments(comments.filter((c) => c.id !== id));
  }

  async function deleteComment(id) {
    await bool.entities.comments.delete(id);
    setComments(comments.filter((c) => c.id !== id));
  }
}
```

## 4. Deployment

```bash
npx bool deploy
```

Your blog is live:
- Public blog at `https://<slug>.bool.so/`
- Admin at `https://<slug>.bool.so/admin/` (only authenticated users)

## What's Happening

1. **Public schema**: `posts` and `comments` are readable by anyone (no auth needed)
2. **Filtering**: Blog homepage only shows `published: true` posts
3. **Admin protection**: You'd add auth checks (e.g., checking user email) to gate `/admin`
4. **Realtime**: Comments are unapproved by default. Admin approves them manually.
5. **No backend**: Everything runs through the Bool SDK. No API code to write.

## Extending

- Add an email notifier: send a webhook when new comments arrive
- Add tags: create a `tags` table with junction table `post_tags`
- Add search: filter posts by title/content keywords
- Add analytics: track page views in a `page_views` table
