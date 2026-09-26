-- Trip Pool payments (Razorpay TEST MODE). The pool itself is a SIMULATED
-- escrow layer: GroupTrip records who paid what; it does not hold funds.
-- The ledger (trip_events) remains the source of truth for balances; these
-- tables track the provider side and guarantee idempotency:
--   one provider order   -> one contribution   (unique order_id)
--   one provider payment -> one contribution   (unique payment_id)
--   one webhook event    -> processed once     (payment_webhook_events PK)

create table if not exists public.pool_contributions (
  id             text primary key,
  trip_id        text not null references public.trips(id) on delete cascade,
  participant_id text not null,
  user_id        text not null,
  amount_paise   bigint not null check (amount_paise > 0),
  currency       text not null default 'INR' check (currency = 'INR'),
  provider       text not null default 'razorpay',
  order_id       text unique,
  payment_id     text unique,
  status         text not null check (status in ('PENDING', 'VERIFIED', 'FAILED', 'REFUND_PENDING', 'REFUNDED')),
  refunded_paise bigint not null default 0 check (refunded_paise >= 0 and refunded_paise <= amount_paise),
  refund_id      text unique,
  failure_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists pool_contributions_trip_idx on public.pool_contributions(trip_id);

create table if not exists public.payment_webhook_events (
  event_id    text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

alter table public.pool_contributions     enable row level security;
alter table public.payment_webhook_events enable row level security;

drop policy if exists "members read contributions" on public.pool_contributions;
create policy "members read contributions" on public.pool_contributions for select using (public.is_trip_member(trip_id));
-- No client-side insert/update policies: only the server (secret key) writes payments.
