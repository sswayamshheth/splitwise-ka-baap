-- trip_events is append-only: block DELETE and TRUNCATE as well as UPDATE (0001).
-- The one exception is the ON DELETE CASCADE from trips: when a trip is deleted,
-- its events go with it. The cascade runs after the trip row is gone, so a
-- delete is allowed only for events whose trip no longer exists.

create or replace function public.trip_events_no_delete() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.trips t where t.id = old.trip_id) then
    raise exception 'trip_events is append-only';
  end if;
  return old;
end $$;

drop trigger if exists trip_events_no_delete on public.trip_events;
create trigger trip_events_no_delete before delete on public.trip_events
  for each row execute function public.trip_events_no_delete();

drop trigger if exists trip_events_no_truncate on public.trip_events;
create trigger trip_events_no_truncate before truncate on public.trip_events
  for each statement execute function public.trip_events_append_only();
