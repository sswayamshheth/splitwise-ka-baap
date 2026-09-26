-- Browser extension pairing tokens (only a SHA-256 hash is stored).
create table if not exists public.extension_tokens (
  token_hash text primary key,
  user_id    text not null,
  created_at timestamptz not null default now()
);
alter table public.extension_tokens enable row level security;
