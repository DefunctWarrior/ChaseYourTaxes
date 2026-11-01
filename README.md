# Chase Your Taxes — Render Deployment

## Environment Variables (set these in Render)

- `DATABASE_URL` — automatically provided by Render Postgres (Internal Connection String)
- `SESSION_SECRET` — a long random string
- `NODE_ENV` — `production`

## Build & Start

- **Build Command:** `npm install`
- **Start Command:** `node src/server.js`

## After first deploy

1. Open the Render Postgres shell (or use any Postgres client) and run the contents of `schema.sql`.
2. Visit `/api/health` to confirm the API is up.
3. Register your first account, then manually set your role to `superadmin` in the database if needed.

## Domain

Point `chaseyourtaxes.com` (and www) to your Render service. Render provides free SSL.
