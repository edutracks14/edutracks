# EduTrackS — Vercel deployment (Turso proxy)

This is the Vercel version of your app. Nothing about how the app works has
changed — it's the same frontend and the same database logic. Only *where*
it runs changed, from Netlify to Vercel.

Your database credentials still never reach the browser. All reads/writes
go through `/api/turso`, a Vercel serverless (Edge) function that holds the
credentials on the server.

## 1. Put this folder on GitHub
Vercel deploys by connecting to a GitHub repository.
- Create a new empty repository on github.com (e.g. `edutracks`)
- Upload/push everything in this folder to it

If you're not comfortable with git commands, GitHub's website lets you
drag-and-drop files directly into a new repo — that works fine here too.

## 2. Import the project into Vercel
- Go to vercel.com and sign in with your GitHub account
- Click "Add New" → "Project"
- Select the repo you just created
- Leave all build settings as default (no build command needed — click Deploy)

## 3. Add the environment variables
In your Vercel project: **Settings → Environment Variables**, add:

| Key | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | `https://your-db-name-yourname.turso.io` |
| `TURSO_AUTH_TOKEN` | your Turso auth token |
| `APP_ALLOWED_ORIGIN` (optional) | `https://your-site.vercel.app` — blocks other websites from calling your API |

Get these from the Turso CLI:
```
turso db show your-db-name --url
turso db tokens create your-db-name
```
(Or from the Turso web dashboard if you don't want to use the CLI.)

## 4. Redeploy
After adding environment variables, go to **Deployments** → click the "..."
menu on the latest deployment → **Redeploy**. Environment variables are only
picked up on a new deploy.

## 5. Verify it's working
- Open your site (`https://your-project.vercel.app`)
- Try logging in with a PIN
- Open your browser's DevTools → Network tab: requests should go to
  `/api/turso` and `/api/login`, and neither should show your database token
- You can also visit `https://your-project.vercel.app/api/login` directly in
  a browser — it will tell you if the server can reach your database,
  without using up a login attempt

## Notes
- The Netlify-specific files (`netlify.toml`, `netlify/functions/`) are not
  included here — Vercel doesn't need them. Routing to `/api/login` and
  `/api/turso` happens automatically because those files live in the `api/`
  folder.
- If you ever want to move off Vercel again, the same pattern (an `api/`
  folder with these two files) works almost unchanged on most other hosts
  that support Edge/serverless functions.
