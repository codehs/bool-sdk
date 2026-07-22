# Deployment — Publishing Your App to Bool

Take your locally-developed app and publish it to `https://<slug>.bool.so`.

## How Publishing Works

```
Your machine
    ↓
bool deploy (zips source + schemas)
    ↓
Bool platform (checks auth, stores in S3)
    ↓
Vercel Sandbox (builds, installs deps)
    ↓
Live URL (https://<slug>.bool.so)
```

## Quick Start

```bash
# From your app directory
npx bool deploy
```

That's it. Your app is live.

## What Gets Deployed

The `bool deploy` command zips:
- Your app source (`src/`, `public/`, `package.json`, etc. — excludes `node_modules`, `.git`, etc.)
- Your schema definitions (`bool/entities/*.json`)
- Your environment config (`.env.bool` → injected at build time)

Size limit: **65 KB compressed**. For most apps (React + schemas), that's plenty.

## Environment Variables at Build Time

When Bool builds your app on Vercel Sandbox:

1. Your `.env.bool` is loaded (admin key)
2. Available as `process.env.BOOL_API_KEY` during build
3. Injected into client bundle as needed

**For Vite/SPA apps:**
```ts
// At build time, these are available
const apiKey = import.meta.env.VITE_BOOL_API_KEY;
// Or fallback to runtime detection
const apiKey = window.env?.BOOL_API_KEY;
```

**For Next.js / Node apps:**
```ts
// At build time (not runtime)
const apiKey = process.env.BOOL_API_KEY;

// For runtime, pass it via API route or config file
```

## Continuous Deployment

### GitHub Actions

```yaml
name: Deploy to Bool
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: npx bool deploy --token ${{ secrets.BOOL_TOKEN }}
```

**Setup:**
1. Create a personal access token in Bool (Settings → Access tokens)
2. Add as GitHub secret: `BOOL_TOKEN`
3. Create `.github/workflows/deploy.yml` with the above
4. Every commit to main triggers a deploy

### Manual Deployment

```bash
export BOOL_TOKEN=bool_live_xxxxx
npx bool deploy
```

### Programmatic Deployment

In CI/CD, use the token flag:

```bash
bool deploy --token "bool_live_xxxxx"
```

## Preview URLs

Every publish creates a unique preview URL while deployment completes:

```
Deploying to prod...
Preview: https://demo-app-XXXX.bool.so (expires in 30 min)
Live: https://demo-app.bool.so (building...)
```

You can test on the preview while the live version deploys.

## Rollback

If you deploy a bad version, redeploy the previous commit:

```bash
git checkout HEAD~1  # previous version
npx bool deploy
git checkout main    # back to current work
```

Or manually in the Bool editor: Projects → [name] → Deployments → [previous] → "Make live"

## Monitoring & Logs

After deploy, check your app in the Bool editor:

**Projects** → [name] → **Live app** → [link]

View build logs and runtime errors in the Bool dashboard.

## Build Optimizations

### Fast Deployments

The 65 KB limit forces efficiency:

- ✅ Tree-shake unused code: `npx esbuild src/index.ts --bundle --minify`
- ✅ Use dynamic imports for heavy libraries
- ✅ Leverage the CDN for static assets (not via the zip)
- ✅ Zero-dependency approach: no node_modules in zip

### Schema Size

Your `bool/entities/` adds a few KB. If you have many tables:

- Combine small related tables? (e.g., `user_profile` + `user_settings`)
- Archive old tables? (move to a history schema)
- Use shorter field names? (save bytes on generated types)

## Special Cases

### Building a Static Site

If your app is HTML + CSS + JS (no backend):

```bash
npx bool deploy
```

Works as-is. Bool serves it.

### Full-Stack (Node Backend)

If you're using a framework like Next.js or Remix:

```bash
# Build locally first
npm run build

# Then deploy
npx bool deploy
```

Bool installs your `package.json` deps and runs the build again, but it's faster if you pre-build locally.

### Monorepo

If your app is in a subdirectory:

```bash
cd apps/my-app
npx bool deploy
```

Or set the directory:

```bash
npx bool deploy --dir ./apps/my-app
```

## Custom Domains

After deploying, you can add a custom domain in Bool:

**Projects** → [name] → **Settings** → **Custom domain**

Point your DNS to Bool's CNAME, refresh cache, done.

## Sharing Before Going Live

Share a preview link before deploying to prod:

```bash
npx bool deploy --preview
```

Creates a temporary URL that expires after 7 days. Great for design reviews or stakeholder feedback.

## Removing Your App

To take an app offline:

1. In Bool editor: **Projects** → [name] → **Settings** → **Delete**
2. Or keep it in Bool and just stop deploying
3. Schema/data stays archived for a month before purge

---

## Troubleshooting

### Deploy Fails with "Zip too large"

Your app is over 65 KB. Options:

- Remove unused dependencies from `package.json`
- Use code splitting / dynamic imports
- Exclude large media files (use external CDN instead)
- Simplify your schema (combine tables, shorter names)

```bash
# Check what's in your zip
ls -lah src/ public/ bool/entities/
du -sh .
```

### Build Fails on Platform

Check the Bool dashboard for build logs. Common issues:

- Missing environment variable (add to `.env.bool`)
- TypeScript error (run `npm run typecheck` locally first)
- Missing peer dependency (add to `package.json`)

### Deploy Hangs

If deployment seems stuck:

```bash
# Ctrl+C to cancel
npx bool deploy
# or try again with verbose
npx bool deploy --verbose
```

The platform has a timeout of 10 minutes. If you hit it, something is wrong with the build.

### App Works Locally but Not After Deploy

Check:
- **Env vars**: Are they set correctly? (check `.env.bool`)
- **Relative paths**: Use `import.meta.env.BASE_URL` or `process.env.VITE_*` for paths
- **API routes**: Do they exist? (Next.js needs `app/api/` or `pages/api/`)
- **Dependencies**: Did you forget to add something to `package.json`?

---

## Next Steps

- [Local development guide](./LOCAL-DEVELOPMENT.md) — building your app
- [Data modeling](./DATA-MODELING.md) — schema best practices
- [FAQ](./FAQ.md) — common questions
