# Overnight brief — GroupTrip Ledger

The team is asleep. Work through this list on your own, following every rule below. **Nobody is available to approve anything.** If a step needs approval, a secret, a database change or a judgement call about someone else's feature, skip it and add it to the morning report. Never wait for input.

Goal: by morning, a noticeably more reliable and polished app for the hackathon demo, with a weather-aware map in the Plan section and NuGen AI ready to switch on, all on a preview deployment, with nothing live broken.

## Hard rules

1. **Branch:** create `overnight` from the current `main`. Commit only there, in small commits with clear messages. You may push `overnight` to origin as a backup. **Never commit to, merge into, or push `main` or `deploy`.**
2. **Production is off-limits:** never run `vercel deploy --prod`, `vercel promote` or `vercel alias`. Deploy only previews: `vercel deploy --target preview --yes`.
3. **Database:** no migrations, no `supabase db push`, no SQL, no direct writes with the server key. The preview uses the **same** database as production, so any data you create through the app is real. Only create or change data inside one trip you create yourself, named **"QA overnight – delete me"**. Never touch other trips, profiles or accounts, except reading. New features must work without schema changes; if one truly needs a new column or table, build it without, and propose the migration in the report.
4. **Secrets and settings:** no changes to environment variables, keys, Vercel settings, Clerk or Supabase settings. Never print a secret value. You may read `web/.env.local` to learn names and to use values locally.
5. **Dependencies:** no upgrades and no `npm audit fix`. The **only** packages you may add are `leaflet`, `react-leaflet@4` and `@types/leaflet`, for the map. Anything else: skip and report.
6. **Teammates' features:** don't remove or redesign them. Fix clear bugs, broken states and wording only. Keep every safety change from earlier sessions: Clerk login and the redirect fix, middleware public routes, the file-store guard, onboarding asking once, all real-UPI paths hidden in demo mode, the PWA files, region sin1, generic chain errors, the chain feature hiding when unconfigured.
7. **AI never computes money** and never decides alerts on its own. Code makes decisions; AI only phrases, summarises and suggests. Every AI output shown to users is a suggestion they can ignore or confirm.
8. **Every commit** must pass type check, lint (no new warnings), tests (the 2 known ganache failures in `tests/chain-onchain.test.ts` are allowed; nothing else may fail) and `npm run build`. If a change can't pass, revert it and report it.
9. **When in doubt, don't.** Report it instead. A small safe night beats a big risky one.

## Work list, in order

Stop a task early if it grows beyond what you can finish safely. Partial features must be hidden or clearly labelled, never half-broken.

### 1. Baseline
Record the current commit, test results, build result and `/api/status` from production in the morning report.

### 2. Vulnerability triage (read-only)
For all npm audit findings, say which are in code the live site runs (server or browser) and which are dev, test or build only. Recommend what to do, but change nothing.

### 3. Walk the demo storyline and fix what's broken
Using Chrome with the signed-in session, on a preview deployment of `overnight` (log into Vercel in the same browser if preview protection blocks you; if it still blocks, use production **read-only** plus the QA trip). Test at phone width (390px) and desktop:

- Log in, onboarding, home, my trips
- Create the QA trip, add members, add itinerary items and bookings
- Add expenses with different split types, confirm split, explain my balance
- Contribute to the pool with the demo checkout, **5 times in a row**; each must succeed and update the pool
- Settle screen, disputes (open and resolve one on the QA trip), activity/history, profile, budget, whiteboard and any other screen reachable from the navigation
- Guest invite view (`/join/...`) signed out
- Assistant in offline mode

For each screen, note: errors, broken links or 404s, console errors, layouts that break at 390px, missing empty, loading or error states, confusing or technical wording, and anything that suggests real money moves. Fix clear bugs and wording within the rules. List everything else.

### 4. Plan section: map and weather-based inclusions, exclusions and alerts
First, search the codebase for any existing weather, map, geocoding or location code and reuse it rather than duplicating.

**Map**
- In the Plan/itinerary section, add a map of the trip: the destination, plus every itinerary item that has or can be given a location, in day order, with a simple line between stops.
- Use `leaflet` + `react-leaflet@4` with OpenStreetMap tiles, and show the required attribution ("© OpenStreetMap contributors"). Load the map only in the browser (dynamic import, no server rendering).
- Get coordinates from the free Open-Meteo geocoding API (no key) using place names. Cache results in memory and in the browser; don't store them in the database. Items without a findable location are listed under the map, not dropped.
- It must work at 390px wide and must not slow down the rest of the page.

**Weather**
- Use the free Open-Meteo forecast API (no key) for the trip destination and dates. Cache responses (at least 30 minutes).
- Forecasts only reach about 16 days ahead. For trips further out, say so plainly ("Forecast available closer to your dates") instead of guessing.
- Classify itinerary items as outdoor, indoor or unknown with simple keyword rules in code (e.g. beach, trek, rafting, boat, hike → outdoor; museum, mall, spa, restaurant → indoor).
- Apply rules in code, per day:
  - **Alerts:** heavy rain (probability ≥ 60% or ≥ 10 mm), extreme heat (≥ 38°C), strong wind (≥ 40 km/h), or thunderstorms, on days with outdoor items.
  - **Exclusions:** outdoor items on alert days are flagged "at risk", with the reason.
  - **Inclusions:** for those days, suggest indoor alternatives or a better time/day with clearer weather, and suggest packing items (rain gear, sunscreen) based on the forecast.
- Show this in the Plan section per day: a small weather strip, alert badges on affected items, and an "Alternatives" panel. Suggestions are never applied automatically; the user chooses.
- Label the data source ("Weather: Open-Meteo").

### 5. NuGen AI integration
- Read the NuGen docs at https://docs.nugen.in (chat completions endpoint, authentication, model names). Base URL `https://api.nugen.in`, Bearer token. Default model `nugen-flash-instruct`, overridable by an env var.
- Add NuGen as the AI provider, server-side only:
  - Environment variables: `NUGEN_API_KEY` (secret, server-only, never `NEXT_PUBLIC_`), and optionally `NUGEN_MODEL`.
  - When `NUGEN_API_KEY` is set, NuGen is used; when not, everything falls back to the existing offline/rule-based behaviour, with no errors or setup wording shown to users.
  - Keep the existing Anthropic code path intact; don't delete it.
  - Generic error messages to users; log only error codes, never the key or full responses containing it.
  - Timeouts (about 15 seconds) and a clean fallback if NuGen is slow or down.
- Use NuGen for:
  1. The existing assistant (ask page and plan assistant), grounded in the same ledger tools, with code-computed numbers only.
  2. The weather feature: turning the code-decided alerts into friendly one-line explanations and ranking or phrasing the indoor alternatives from a list the code provides. NuGen may not invent new alerts or change amounts.
- Update `/api/status` to report `ai: "nugen"` when the key is set.
- If `NUGEN_API_KEY` is in `web/.env.local`, test it locally with a couple of real calls. Otherwise, test with mocked responses only, and say in the report that it hasn't been tested live.
- Add `NUGEN_API_KEY` and `NUGEN_MODEL` to `web/.env.example` (names only, no values).

### 6. Low-risk known issues
- `/status`: build a simple page that shows the `/api/status` result in plain words (e.g. "Database: connected"). Read-only, no new data.
- Add a short, calm error state wherever an API failure currently shows a blank screen or raw error text.

### 7. Tests
Add automated tests for anything you fixed and built, including: onboarding shown only once; demo checkout succeeding across fresh instances; real-UPI options hidden in demo mode; weather rules (alerts, exclusions, inclusions at each threshold, trips beyond the forecast range); outdoor/indoor classification; NuGen fallback when the key is missing, slow or failing; no secret in any response.

### 8. Preview deploy and final check
Deploy `overnight` as a preview. On the preview: repeat the demo checkout 3 times; open the QA trip's Plan section and check the map and weather at 390px and desktop; do a quick pass of the main screens. Push `overnight` to origin.

## Morning report

Write `MORNING_REPORT.md` on the `overnight` branch (no secret values) with:

1. **One-paragraph summary** of the night.
2. **Preview URL**, and the exact command to promote it to production if approved.
3. **Changes**, each in one line with its commit.
4. **What to test** in the morning, as a short checklist, including the map, weather alerts and NuGen.
5. **To switch on NuGen in production:** the exact safe command to add `NUGEN_API_KEY` (and `NUGEN_MODEL` if used) to Vercel for Production and Preview without printing the value, and whether it was tested live.
6. **Vulnerability triage** from task 2.
7. **Found but not fixed**, with a recommendation for each.
8. **Skipped because it needed approval**, with what exactly is needed (including any proposed migration).
9. **Data created**: the QA trip's name and ID, so the team can delete it.

Commit it, push `overnight`, and stop.
