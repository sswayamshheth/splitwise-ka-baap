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

Vercel project settings: framework Next.js, root directory `web`, Node.js 22.x, personal scope `lakhotiaaryan-6870s-projects`. The project is **not** connected to GitHub; deploys are made with the Vercel CLI from the repo root.

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

### Not set yet (features off until added)

| Name | Effect when missing |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Payments use the labelled demo checkout (no real money) |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhooks not verified (webhook URL: `https://group-trip-ledger-six.vercel.app/api/webhooks/razorpay`) |
| `ANTHROPIC_API_KEY` | "Ask the ledger" assistant runs in offline mode |
| `NEXT_PUBLIC_AI_PROXY_URL` | Optional; defaults to `/api/ai` |
| `DEMO_PAYMENTS` | Optional; deliberately not set. Set to `off` to disable the demo checkout when Razorpay keys are missing |

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

To turn on payments: add the three `RAZORPAY_*` test-mode variables, set the webhook in the Razorpay dashboard to the URL above, and redeploy production.

## Database

Applied to `mqfdrbxigeytgkeejcfi`, in order:

1. `0001_grouptrip_ledger.sql` — `profiles`, `trips`, `trip_members`, `trip_events`; RLS via `auth.jwt()->>'sub'`; `trip_events` blocks UPDATE.
2. `0002_trip_pool_payments.sql` — `pool_contributions`, `payment_webhook_events`, RLS.
3. `0003_trip_events_block_delete.sql` — `trip_events` blocks direct DELETE and TRUNCATE; events are still removed when their trip is deleted (cascade). Verified in production: deleting a throwaway trip returned 200 and removed it.

4. `0004_profile_preferences_cards.sql` — adds `profiles.interests`, `interests_asked`, `cards` and `pool_contributions.purpose`, `item_id`, `method_label`. A teammate committed it as `0003_…`; renumbered to 0004 (contents unchanged) because version 0003 was already applied.

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
| PWA install on a phone | Pass after fix — installed on iPhone. First attempt: email-code sign-in succeeded but the login page never navigated away, and a retry showed "You're already signed in". Fixed in `33177a5` (see below) and deployed to production; retest on the iPhone PWA passed — sign-in goes straight into the app. |
| No secrets in pages / bundles / responses | Pass — 22 deployed resources and 47 client chunks scanned |

Demo data kept in production: the "Smoke Test" trip (Goa, 30 Sep – 8 Oct 2026) with one ₹1,200 "Smoke test dinner" expense.

## Changes after the first production deploy

- `33177a5` — `web/components/app/EmailLogin.tsx`: the login page redirects if the user is already signed in; after verifying the code it calls `setActive` and navigates with `router.replace`, falling back to `window.location.assign` if the route doesn't change; Clerk's `session_exists` error now redirects instead of showing an error. Deployed with `vercel deploy --prod` (deployment `group-trip-ledger-e3nmp4vox`).
- `ebfefdd` — merged `origin/main` `080f74a` (vendor UPI QR payments, AI plan assistant, demo checkout, QA fixes). No conflicts; 178 tests pass. `6765db5` renumbered its migration to 0004, applied to production, then deployed with `vercel deploy --prod` (deployment `group-trip-ledger-r0cnaymyd`). Signed-in check: `/api/me` returns the new profile fields, payments config reports `mode: demo`.

## Known issues

- **No `/status` page.** It is listed as a public route but only `/api/status` exists.
- **No delete-trip button in the UI.** `DELETE /api/trips/[id]` (owner only) works but nothing in the app calls it.
- **Payments run in demo mode and the assistant is offline** until the Razorpay and Anthropic keys are added (see above).
- **Next.js 14.2.35 security advisories** (npm audit: critical). Every fix requires Next 15+, a major upgrade we chose not to make. Advisories relevant to this app: denial of service in the App Router / Server Components / Server Actions, cache poisoning of middleware redirects and of React Server Component responses, and cache confusion of response bodies. Others (Image Optimizer, Pages Router i18n, Windows-hosted RCE, Edge Server Actions, custom servers) do not match this setup.
- Other npm audit findings are dev/build-time only: `vitest` (critical) and `vite` (tests), `glob`, `eslint-config-next`, `@next/eslint-plugin-next` (lint), `postcss` (CSS build).
- **PWA is minimal:** manifest and placeholder icons only, no service worker (no offline support).
- **`/api/demo` resets the demo by deleting and recreating its trip**, which conflicts with the rule that demo resets should create new trips. Left as is.
- **First production deploy was accidental** (a CLI deploy without `--target`); it was kept because it is the same build as the preview.
- **Clerk secret key was exposed** in a terminal transcript during setup and was rotated before being uploaded to Vercel. The keys in Vercel are the new ones.
- `ai/`, `simulator/`, `docs/requests.md` and `seed/` are empty placeholders.
- **Some existing users are asked for name and UPI ID again on first sign-in to production.** The app treats a user as onboarded only if a `profiles` row with a name exists in Supabase. The Clerk development instance is shared with local development, so accounts created before the production database existed (their profiles lived in the local file store) have no row in production. It is one-time per account; new accounts are unaffected. Fix not decided yet.
- **Login ignores the middleware's `redirect_url`.** Signed-out users sent to `/login?redirect_url=…` land on `/home` after sign-in, because the page reads `?next=`. Pre-existing; not changed.

## Demo-day checklist

- [ ] A few minutes before judging, open https://group-trip-ledger-six.vercel.app/api/status (there is no `/status` page and no Render services to wake). Check it shows `store: supabase` and `auth: clerk`.
- [ ] Supabase free projects pause after about a week without activity. Open the Supabase dashboard the day before and restore the project if it is paused.
- [ ] The Clerk development instance allows up to 100 users. Reuse test accounts rather than creating new ones per run.
- [ ] Chain signing key: not applicable (no chain module). If one is added later, never rotate its key once data exists.
- [ ] Demo resets must create new trips rather than delete old ones. `trip_events` is append-only; never update or delete its rows.
- [ ] Clerk shows a "development mode" badge on sign-in; this is expected with `pk_test_` keys on `*.vercel.app`.
