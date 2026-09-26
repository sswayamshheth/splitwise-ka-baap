-- Optional travel preferences (Harmony Score) and saved cards/accounts by NAME only.
alter table public.profiles add column if not exists interests jsonb;
alter table public.profiles add column if not exists interests_asked boolean not null default false;
alter table public.profiles add column if not exists cards jsonb not null default '[]'::jsonb;

-- Vendor payments through Razorpay use the same payments table.
alter table public.pool_contributions add column if not exists purpose text not null default 'pool' check (purpose in ('pool', 'vendor'));
alter table public.pool_contributions add column if not exists item_id text;
alter table public.pool_contributions add column if not exists method_label text;
