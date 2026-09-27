# Deployment notes — GroupTrip Ledger

Deployed 2026-09-26 from the `deploy` branch. No secret values appear in this file.

## URLs

| Service | Environment | URL |
|---|---|---|
| Web app (Vercel project `group-trip-ledger`) | Production | https://group-trip-ledger-six.vercel.app |
| Web app | Preview | https://group-trip-ledger-qbid5b568-lakhotiaaryan-6870s-projects.vercel.app (behind Vercel login; protection left on) |
| Database | Supabase, project ref `mqfdrbxigeytgkeejcfi` (Singapore) | — |
| AI service (`ai/`) | Not deployed: empty stub, not used by the app | — |
| Simulator (`simulator/`) | Not deployed: empty stub, not used by the app | — |

Vercel project settings: framework Next.js, root directory `web`, Node.js 22.x, functions in `sin1` (Singapore, set in `web/vercel.json`, next to the database), personal scope `lakhotiaaryan-6870s-projects`. The project is **not** connected to GitHub; deploys are made with the Vercel CLI from the repo root.

## Environment variables

### Vercel (`group-trip-ledger`) — set for Production and Preview

| Name | Exposure |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Browser (Clerk development instance, `pk_test_`) |
| `CLERK_SECRET_KEY` | Server, sensitive (`sk_test_`) |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | Browser |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | Browser |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | Browser |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | Browser |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser (anon/publishable key; not read by current code) |
| `SUPABASE_SECRET_KEY` | Server, sensitive |

### Intentionally not set

| Name | Why |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Not used by decision (see Decisions). Without them, payments run through the in-app demo checkout, and `/api/webhooks/razorpay` rejects every request (400 "Invalid webhook signature"; verified in production). |
| `ANTHROPIC_API_KEY` | Not used by decision (see Decisions). The assistant runs in offline mode. |
| `NEXT_PUBLIC_AI_PROXY_URL` | Optional; defaults to `/api/ai`. |
| `DEMO_PAYMENTS` | Optional. Leave unset so the demo checkout stays on; `off` would switch payments off entirely. |
| `ANCHOR_PRIVATE_KEY`, `ANCHOR_CONTRACT`, `ANCHOR_SALT`, `ANCHOR_DEPLOY_BLOCK`, `ANCHOR_RPC_URL` | Blockchain sealing on Ethereum Sepolia (testnet). Not set, so the feature is hidden (`/api/status` shows `chain: false`). `ANCHOR_PRIVATE_KEY` is a wallet private key and `ANCHOR_SALT` must be set to a private value if this is ever turned on; both are server-only. |
| `NUGEN_API_KEY` | Optional, secret, server-only. Not set: the assistant, plan assistant and weather notes run rule-based. When set, NuGen only words/suggests; code computes every number. Used by both NuGen clients (`lib/server/nugen.ts` and the Digital Twin's `lib/nugen/client.ts`). Never tested with a live key. |
| `NUGEN_MODEL` | Optional model for `lib/server/nugen.ts` (default `nugen-flash-instruct`). The Digital Twin client uses `NUGEN_MODEL_ID` / `NUGEN_BASE_MODEL` / `NUGEN_ALIGNMENT_ID` instead — align these later. `NUGEN_API_BASE` optionally overrides its base URL. |
| `GOOGLE_PLACES_API_KEY` | Optional, server-only (Digital Twin place ratings). Not set. |
| `TWIN_DEBUG` | Debug logging for the Digital Twin. Never set in production. |
| `ALLOW_LOCAL_FILE_STORE` | Local `next start` only. Must never be set on Vercel; the file store refuses to run on Vercel regardless. |

Local source of values: `web/.env.local` (git-ignored). Note that some lines there have a space after `=`; don't `source` the file in a shell.

## How to redeploy

All commands run from the repo root (it is linked to the Vercel project via `.vercel/`, which is git-ignored). **Always pass the target explicitly**: on this project a bare `vercel deploy` went to production.

- Preview: `vercel deploy --target preview --yes`
- Production: `vercel deploy --prod --yes`
- Database migrations: add a new file in `supabase/migrations/` (never edit applied ones), then `npx supabase db push` (project is already linked).

Adding or changing an environment variable, then redeploy:

- Production: `vercel env add NAME production` (value via stdin or prompt)
- Preview, all branches: `vercel env add NAME preview ""` — the empty-string branch argument is needed; without it this CLI version keeps asking for a branch.
- Use `--force` to overwrite an existing variable. Env changes only take effect on the next deploy.

To switch Razorpay on in future (not planned; see Decisions): add the three `RAZORPAY_*` test-mode variables, set the Razorpay webhook to `https://group-trip-ledger-six.vercel.app/api/webhooks/razorpay`, and redeploy production.

## Decisions

- **No Razorpay.** Payments run in demo mode by design: the in-app demo checkout simulates payments, and no money moves through the app. The Razorpay code stays in place so it can be switched on later by adding keys.
- **No Anthropic API.** The assistant runs in offline mode by design: rule-based answers over the same ledger tools, no LLM. The Claude code stays in place so it can be switched on later by adding a key.

## Database

Applied to `mqfdrbxigeytgkeejcfi`, in order:

1. `0001_grouptrip_ledger.sql` — `profiles`, `trips`, `trip_members`, `trip_events`; RLS via `auth.jwt()->>'sub'`; `trip_events` blocks UPDATE.
2. `0002_trip_pool_payments.sql` — `pool_contributions`, `payment_webhook_events`, RLS.
3. `0003_trip_events_block_delete.sql` — `trip_events` blocks direct DELETE and TRUNCATE; events are still removed when their trip is deleted (cascade). Verified in production: deleting a throwaway trip returned 200 and removed it.

4. `0004_profile_preferences_cards.sql` — adds `profiles.interests`, `interests_asked`, `cards` and `pool_contributions.purpose`, `item_id`, `method_label`. A teammate committed it as `0003_…`; renumbered to 0004 (contents unchanged) because version 0003 was already applied.

5. `0005_extension_tokens.sql` — new `extension_tokens` table (hashed browser-extension pairing tokens), RLS on. Additive only.
6. `0006_settle_up_payments.sql` — widens the `pool_contributions.purpose` check to allow `'settle'`. Replaces a constraint; no rows changed (the 3 existing rows passed the new check).

Remote migration versions are now 0001–0006; new migrations must use 0007 or higher.

Triggers on `trip_events`: `trip_events_no_update`, `trip_events_no_delete`, `trip_events_no_truncate`.

The server uses `SUPABASE_SECRET_KEY` (bypasses RLS). In production, if it is missing the app now refuses to start the local file store instead of silently writing to disk.

## Smoke test (production, 2026-09-26)

| Check | Result |
|---|---|
| `/status` | Fail — no page exists (see known issues). `/api/status` returns `store: supabase, auth: clerk, ai: offline` |
| `/login` | Pass |
| `/signup` | Redirects to `/login` by design (single email/phone flow) |
| Sign-up with a fresh email | Pass |
| After sign-in | Pass — lands on the "Who's travelling" onboarding page |
| `/demo/*` signed out | Pass (all 6 pages) |
| Protected pages signed out | Pass — redirect to `/login` |
| `/join/*` signed out | Pass |
| Create trip → add expense → balance | Pass — ₹1,200 expense split 4 ways shows "You are owed ₹900", ledger reconciled |
| Trip delete with 0003 trigger | Pass |
| Chain module | Not applicable (no `lib/chain` / `chain_blocks`) |
| PWA manifest and icons | Pass — load signed out, linked from the layout |
| `/status` (27 Sep) | Pass — plain-words page: database connected, sign-in ready, assistant rule-based, payments demo, blockchain off |
| PWA install on a phone | Pass after fix — installed on iPhone. First attempt: email-code sign-in succeeded but the login page never navigated away, and a retry showed "You're already signed in". Fixed in `33177a5` (see below) and deployed to production; retest on the iPhone PWA passed — sign-in goes straight into the app. |
| No secrets in pages / bundles / responses | Pass — 22 deployed resources and 47 client chunks scanned |

Demo data kept in production: the "Smoke Test" trip (Goa, 30 Sep – 8 Oct 2026) with one ₹1,200 "Smoke test dinner" expense.

## Changes after the first production deploy

- `33177a5` — `web/components/app/EmailLogin.tsx`: the login page redirects if the user is already signed in; after verifying the code it calls `setActive` and navigates with `router.replace`, falling back to `window.location.assign` if the route doesn't change; Clerk's `session_exists` error now redirects instead of showing an error. Deployed with `vercel deploy --prod` (deployment `group-trip-ledger-e3nmp4vox`).
- `ebfefdd` — merged `origin/main` `080f74a` (vendor UPI QR payments, AI plan assistant, demo checkout, QA fixes). No conflicts; 178 tests pass. `6765db5` renumbered its migration to 0004, applied to production, then deployed with `vercel deploy --prod` (deployment `group-trip-ledger-r0cnaymyd`). Signed-in check: `/api/me` returns the new profile fields, payments config reports `mode: demo`.

- `6713d64`…`33df950` — demo checkout made stateless (no server memory; signing key derived from `SUPABASE_SECRET_KEY`, no new variable); user-facing payment and assistant screens no longer mention Razorpay test mode, env var names or missing keys; the vendor UPI QR option is hidden in demo mode (code kept); functions moved to `sin1`. Deployed with `vercel deploy --prod` (deployment `group-trip-ledger-4aelg74cw`).
- `51d9e9e` — "Pay someone else" (real UPI payment) hidden in demo mode, like the vendor UPI option; code kept.
- `30be048` — onboarding asks once: `/onboarding` moves on if a name is already saved, and `/onboarding/interests` moves on if preferences were already answered. Deployed with `vercel deploy --prod` (deployment `group-trip-ledger-e8cg4u1lz`, 2026-09-26), together with `51d9e9e`.
- Data fix (2026-09-27, approved): `interests_asked` set to `true` for the 3 profiles created before the preferences feature went live (they had a name but the new column defaulted to `false`, so they would have been sent to the preferences page after already onboarding). Nothing else in those rows changed.

- 2026-09-27: merged `origin/main` `7eafce1` (browser extension, blockchain proof on Sepolia, QR scanning, UPI to the organiser, Razorpay settle-ups) as `6e9bffa`, then: every real UPI payment (`upi://` links: Pay anyone, vendor UPI, Contribute UPI, Settle "Open UPI app", Record-a-deposit) is hidden in demo mode and labelled "real payment" when shown, via one `useRealUpiAllowed()` check and a self-hiding `UpiPayPanel`; contributions default to the checkout; Razorpay settle/request buttons need real keys; chain errors are generic and the chain feature is hidden without its variables; the file store always refuses on Vercel. Migrations 0005/0006 applied. Deployed with `vercel deploy --prod` (deployment `group-trip-ledger-2tvsp5vtp`).

- 2026-09-27 overnight + deadline merge (all on `main`, deployed as `group-trip-ledger-qdgdi01qe`):
  - Demo walk fixes: assistant help text no longer flagged as unverified, pinned what-if names a real member; demo payment ids shown as "Demo payment"; /demo/expenses fits 390px; activity feed/Profile no longer say Razorpay test mode; itinerary parser uses "Day N" markers for dates and cleans titles; calm error wording for network failures (`c8a9a33`, `d6ec4b9`, `812f63e`, `a1eabc1`, `e439a31`).
  - Plan **Map & weather** (`d9ad71f`): Leaflet/OSM map in day order; Open-Meteo forecast; code-decided alerts (rain ≥60 % or ≥10 mm, ≥38 °C, wind ≥40 km/h, thunderstorms) on days with outdoor items; at-risk badges; Alternatives (clearer day with user-confirmed Move, indoor ideas, packing). Server fallback `/api/forecast` when the browser's Open-Meteo call fails (`ff191a7`).
  - **NuGen** (`2edf6ec`): optional, server-only; rewords engine answers (figures re-verified), rewrites free-form plan requests into built-in planner commands, words weather alerts. `/api/status` reports `ai: nugen`.
  - `/status` page in plain words; `/api/status` now checks the database read-only and reports the payment mode (`f67e9c0`).
  - Merged teammates' Weather Digital Twin, OSM alternatives, NuGen intelligence, destination picker and UPI settle-ups (`869e63e`); their receiver UPI QR also hides itself in demo mode.

## Known issues

- **No delete-trip button in the UI.** `DELETE /api/trips/[id]` (owner only) works but nothing in the app calls it.
- **Next.js 14.2.35 security advisories** (npm audit: critical). Every fix requires Next 15+, a major upgrade we chose not to make. Advisories relevant to this app: denial of service in the App Router / Server Components / Server Actions, cache poisoning of middleware redirects and of React Server Component responses, and cache confusion of response bodies. Others (Image Optimizer, Pages Router i18n, Windows-hosted RCE, Edge Server Actions, custom servers) do not match this setup.
- Other npm audit findings are dev/build-time only: `vitest` (critical) and `vite` (tests), `glob`, `eslint-config-next`, `@next/eslint-plugin-next` (lint), `postcss` (CSS build).
- **PWA is minimal:** manifest and placeholder icons only, no service worker (no offline support).
- **`/api/demo` resets the demo by deleting and recreating its trip**, which conflicts with the rule that demo resets should create new trips. Left as is.
- **First production deploy was accidental** (a CLI deploy without `--target`); it was kept because it is the same build as the preview.
- **Clerk secret key was exposed** in a terminal transcript during setup and was rotated before being uploaded to Vercel. The keys in Vercel are the new ones.
- `ai/`, `simulator/`, `docs/requests.md` and `seed/` are empty placeholders.
- **Two weather features on the Plan page:** the Digital Twin's "Weather Intelligence" card and the "Map & weather" section overlap. Both kept for the deadline; consolidate afterwards.
- **Digital Twin uses the wrong "Manali" for trips created before the destination picker** (no stored coordinates): it showed 34 °C (Tamil Nadu). New trips pick a place with coordinates and are fine. The Map & weather section picks Himachal Pradesh from the itinerary's places.
- **Open-Meteo free quota is per IP per day.** A shared network hit HTTP 429 on 27 Sep; the Plan page now falls back to `/api/forecast`. The Digital Twin also has recorded replay data.
- **NuGen never tested with a real key** (mocked tests only).
- **No dispute feature** in the real app (only in the static `/demo` mockups).
- **Itinerary text parser takes one price per line:** "homestay ₹12,000, paragliding ~₹3,000 each" becomes one item.
- **Open-Meteo geocoding knows towns, not landmarks** ("Solang Valley", "Hampta Pass" aren't found); such items are listed under the map.
- npm audit triage (27 Sep): of 45 findings only `next` (critical) runs on the live site; 32 are inside `ganache` (dev-only chain tests; the lockfile makes `npm audit --omit=dev` count them as production), 11 are dev tooling, 1 is PostCSS bundled in Next (build only).
- **2 on-chain tests fail locally** (`tests/chain-onchain.test.ts`): ganache's native module is missing for Node 24 (`uws_darwin_arm64_137.node`). Not verified on Node 22. The `chain:local-test` npm script points to a file that doesn't exist.
- **Browser-extension tokens never expire.** They are stored hashed and can be re-issued from Profile, but there is no expiry or revoke list.
- npm audit is now 45 findings (7 critical); the new critical ones come from `ganache` (dev only). The only runtime critical is still `next`.
- **UPI flows hidden in demo mode.** "Pay someone else" and the vendor "UPI app (vendor's QR)" option open a real payment in the user's own UPI app, so both are hidden while payments run in demo mode. The code is kept.
- **Some existing users are asked for name and UPI ID again on first sign-in to production.** The app treats a user as onboarded only if a `profiles` row with a name exists in Supabase. The Clerk development instance is shared with local development, so accounts created before the production database existed (their profiles lived in the local file store) have no row in production. It is one-time per account; new accounts are unaffected. **Accepted as is** (no data import). As of 2026-09-27 all 5 Clerk accounts have a profile with a name, so nobody is affected any more.
  - Investigated 2026-09-26/27 after reports of repeat onboarding: no saved answers were lost. The repeats were (1) the pre-production accounts above and (2) the new preferences page for 3 profiles created before that feature (fixed by the data fix above). Onboarding pages now also redirect if already answered (`30be048`).
  - UPI IDs: none of the 5 profiles has one because none was entered. Tested on production: a test UPI ID saved from the Profile page was stored in `profiles.upi_id` under the Clerk user ID, then cleared again (back to NULL).
- **Login ignores the middleware's `redirect_url`.** Signed-out users sent to `/login?redirect_url=…` land on `/home` after sign-in, because the page reads `?next=`. Pre-existing; not changed.

## Demo-day checklist

- [ ] A few minutes before judging, open https://group-trip-ledger-six.vercel.app/status (plain-words page; also wakes the server) or /api/status. Check it says "Everything is up" (database connected, sign-in ready).
- [ ] Supabase free projects pause after about a week without activity. Open the Supabase dashboard the day before and restore the project if it is paused.
- [ ] The Clerk development instance allows up to 100 users. Reuse test accounts rather than creating new ones per run.
- [ ] Chain signing key: not applicable (no chain module). If one is added later, never rotate its key once data exists.
- [ ] Demo resets must create new trips rather than delete old ones. `trip_events` is append-only; never update or delete its rows.
- [ ] Clerk shows a "development mode" badge on sign-in; this is expected with `pk_test_` keys on `*.vercel.app`.
