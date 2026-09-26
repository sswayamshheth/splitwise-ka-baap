# Deployment brief — GroupTrip Ledger

You are deploying a hackathon project (HackCelestial 3.0 final round). Work in phases. **Stop after each phase, report what you found or did, and wait for approval before starting the next one.**

## The project

- Group travel app where the itinerary is the ledger: bookings, participants, shared expenses, contributions into a trip pool, disputes and settlement.
- Mobile-first **PWA** plus a desktop organizer console.
- Monorepo:
  - `web/` — Next.js **14.2.35**, App Router, TypeScript, Tailwind. No `src/` folder: code lives in `web/app`, `web/lib`, `web/components`.
  - `supabase/migrations/` — Postgres schema.
  - Possibly `ai/` (Python FastAPI) and `simulator/` (Node payment-partner simulator). Confirm in Phase 1 whether these exist and are actually used.
- Auth: **Clerk v6** (`@clerk/nextjs@6`) connected to Supabase as a third-party auth provider. Middleware is `web/middleware.ts`; public routes are listed there.
- Database: Supabase Postgres, region Singapore. RLS policies use `auth.jwt()->>'sub'` (Clerk user IDs are text, not uuid).
- Hosting targets: **Vercel** for `web/` (root directory `web`), **Render** for `ai/` and `simulator/` if they exist.
- Possibly a tamper-evident chain module in `web/lib/chain` with table `chain_blocks` (append-only by design).

## Rules — follow these throughout

1. **Never print, log, echo or commit secret values.** Read env files only to learn variable names. When reporting, show names, never values. Confirm `.env*` files are gitignored before any commit.
2. **Do not upgrade major versions** of Next.js, React or Clerk. Do not run `npm audit fix --force`. Do not use `--force` or `--legacy-peer-deps` to get past install errors — report the conflict instead.
3. **Do not remove or bypass Clerk**, and do not make protected routes public to get past an error. Report it instead.
4. **Keep the Clerk development instance** (`pk_test_` / `sk_test_` keys). It works on `*.vercel.app` domains; a production instance needs a custom domain we don't have.
5. **Work on the `deploy` branch.** Small commits with clear messages. Never force-push to `main`.
6. **Ask before**: any production deploy, running database migrations, deleting or moving files, changing another teammate's feature logic, or anything that could cost money.
7. **Fix build blockers minimally.** If a fix would change how a feature behaves, stop and report it rather than deciding.
8. `chain_blocks` and the `events` table are append-only. Never try to update or delete rows in them.

## Phase 1 — Inspect (read-only, change nothing)

Report back with:

1. Repo map: top-level folders, which ones are live apps, and anything that looks duplicated or stray (e.g. a `components/` folder at the repo root, committed `.DS_Store` files).
2. Services that need hosting, with the start command for each.
3. Every environment variable referenced in code (`process.env.*`, `os.environ`, `NEXT_PUBLIC_*`), grouped by service. For each: is it present in the local env file (name only)? Is it server-only or exposed to the browser? Flag any secret that has a `NEXT_PUBLIC_` prefix.
4. Results of, inside `web/`: `npm ci`, `npm run lint`, `npm run build`. Summarise errors, don't fix yet.
5. Migrations in `supabase/migrations/`, in order, and whether they look safe to run on the existing project.
6. Anything that will break when hosted: hard-coded `localhost` URLs, writes to the local file system on Vercel, missing `runtime = "nodejs"` where Node APIs are used, secrets in client components.
7. A proposed plan for Phases 2–7 with anything you need from me.

## Phase 2 — Make it build

Fix only what blocks `npm run build` in `web/` (and the equivalent for other services). Commit on `deploy`. Report each fix in one line.

## Phase 3 — Database (ask first)

1. Show me the migrations you intend to apply and in what order.
2. After approval: `npx supabase link` to the project, then `npx supabase db push` (I am already logged in with `npx supabase login`). If linking needs the database password, ask me to enter it myself.
3. Verify the tables exist. Report.

## Phase 4 — Web app on Vercel

1. Link `web/` with `vercel link` (I am logged in). Project settings: framework Next.js, root directory `web`, Node.js 20.x or 22.x.
2. Add every required env var for **Production** and **Preview** using `vercel env add`, reading values from the local env file without printing them.
3. Deploy a **preview** first and report the URL.
4. After I approve: deploy to production and report the URL.

## Phase 5 — Other services on Render (only if they exist and are used)

1. Check or create `render.yaml` for `ai/` and `simulator/` with build/start commands and health checks.
2. List the env vars each service needs (names only). I will create the services in the Render dashboard from the blueprint and paste values there myself.
3. Once they're live, set their URLs in Vercel (e.g. `AI_URL`, `SIMULATOR_URL`) and point the simulator's webhook URL at the Vercel deployment. Redeploy.

## Phase 6 — Smoke test the deployed site

Check on the production URL and report pass/fail for each:

- `/status` (if present) shows every service up
- `/login` and `/signup` load; sign-up with a fresh email works; after sign-in the user lands on a real page, not a 404
- `/demo/*` pages load without logging in
- Protected pages redirect to `/login` when signed out
- Guest routes under `/join/*` load without logging in
- Core flow works end to end: create a trip, add an expense, see the balance update
- If the chain module is present: `/api/chain/public-key` responds; `/api/chain/<tripId>/validate` reports `intact: true` for a test trip
- PWA: manifest loads and the app can be installed on a phone
- No secret values appear in the browser's page source or network responses

## Phase 7 — Hand back

Write `DEPLOYMENT_NOTES.md` (no secret values) containing:

- Production and preview URLs for each service
- Which env var names are set where
- How to redeploy each service
- Known issues and anything skipped
- Demo-day checklist: open `/status` a few minutes before judging to wake Render services; Clerk development instances allow up to 100 users; never rotate the chain signing key once data exists; demo resets must create new trips rather than delete old ones

Commit it on `deploy` and ask me before merging `deploy` into `main`.
