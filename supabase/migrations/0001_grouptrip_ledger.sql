-- GroupTrip Ledger schema.
-- Auth is Clerk: user ids are text (user_2abc...), and RLS reads the Clerk
-- user id from the JWT's `sub` claim (auth.jwt()->>'sub'), not auth.uid().
-- The Next.js API uses the server secret key and does its own membership
-- checks; the RLS policies below protect direct client access.

create table if not exists public.profiles (
  user_id    text primary key,
  name       text not null,
  email      text,
  phone      text,
  upi_id     text,
  created_at timestamptz not null default now()
);

create table if not exists public.trips (
  id          text primary key,
  owner_id    text not null,
  name        text not null,
  destination text not null,
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'active' check (status in ('active', 'closed')),
  join_code   text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.trip_members (
  trip_id        text not null references public.trips(id) on delete cascade,
  user_id        text not null,
  participant_id text not null,
  role           text not null default 'member' check (role in ('owner', 'member')),
  joined_at      timestamptz not null default now(),
  primary key (trip_id, user_id),
  unique (trip_id, participant_id)
);
create index if not exists trip_members_user_idx on public.trip_members(user_id);

-- The ledger: an append-only event log per trip. (trip_id, seq) is the
-- concurrency guard — two writers can never both append at the same position.
create table if not exists public.trip_events (
  trip_id    text not null references public.trips(id) on delete cascade,
  seq        integer not null check (seq > 0),
  event      jsonb not null,
  actor      text not null,
  ts         timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (trip_id, seq)
);

-- Events are never edited or deleted, only appended.
create or replace function public.trip_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'trip_events is append-only';
end $$;
drop trigger if exists trip_events_no_update on public.trip_events;
create trigger trip_events_no_update before update on public.trip_events
  for each row execute function public.trip_events_append_only();

alter table public.profiles     enable row level security;
alter table public.trips        enable row level security;
alter table public.trip_members enable row level security;
alter table public.trip_events  enable row level security;

create or replace function public.is_trip_member(t text) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.trip_members m where m.trip_id = t and m.user_id = (auth.jwt()->>'sub'))
$$;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all using (user_id = (auth.jwt()->>'sub')) with check (user_id = (auth.jwt()->>'sub'));

drop policy if exists "members read trips" on public.trips;
create policy "members read trips" on public.trips for select using (public.is_trip_member(id));

drop policy if exists "members read members" on public.trip_members;
create policy "members read members" on public.trip_members for select using (public.is_trip_member(trip_id));

drop policy if exists "members read events" on public.trip_events;
create policy "members read events" on public.trip_events for select using (public.is_trip_member(trip_id));
