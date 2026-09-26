-- Settle-up transfers paid through Razorpay (checkout or payment link) are stored
-- like other payments; for purpose 'settle', item_id holds the member being paid.
alter table public.pool_contributions drop constraint if exists pool_contributions_purpose_check;
alter table public.pool_contributions add constraint pool_contributions_purpose_check check (purpose in ('pool', 'vendor', 'settle'));
