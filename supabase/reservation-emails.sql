-- Send reservation confirmations and changes through the send-reservation-email
-- Edge Function. Create reservation_email_webhook_secret in Supabase Vault first.
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create table if not exists public.gmail_email_daily_usage (
  send_date date primary key,
  sent_count integer not null default 0 check (sent_count between 0 and 500)
);

create table if not exists public.reservation_email_queue (
  id bigint generated always as identity primary key,
  to_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null,
  locked_until timestamptz,
  sent_at timestamptz,
  last_error text
);

create index if not exists reservation_email_queue_ready_idx
  on public.reservation_email_queue (next_attempt_at, created_at)
  where status = 'queued';

create index if not exists reservation_email_queue_lease_idx
  on public.reservation_email_queue (locked_until)
  where status = 'sending';

alter table public.gmail_email_daily_usage enable row level security;
alter table public.reservation_email_queue enable row level security;
revoke all on table public.gmail_email_daily_usage from public, anon, authenticated;
revoke all on table public.reservation_email_queue from public, anon, authenticated;
grant all on table public.gmail_email_daily_usage to service_role;
grant all on table public.reservation_email_queue to service_role;

create or replace function public.claim_gmail_email_quota(p_count integer default 1)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_send_date date := (pg_catalog.now() at time zone 'Asia/Singapore')::date;
begin
  if p_count is null or p_count < 1 or p_count > 500 then
    raise exception 'Invalid email quota reservation count';
  end if;

  insert into public.gmail_email_daily_usage (send_date, sent_count)
  values (v_send_date, 0)
  on conflict (send_date) do nothing;

  update public.gmail_email_daily_usage
     set sent_count = sent_count + p_count
   where send_date = v_send_date
     and sent_count + p_count <= 500;

  return found;
end;
$$;

create or replace function public.enqueue_reservation_email(
  p_to_email text,
  p_subject text,
  p_body text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
  v_next_day timestamptz :=
    (((pg_catalog.now() at time zone 'Asia/Singapore')::date + 1)::timestamp)
      at time zone 'Asia/Singapore';
begin
  insert into public.reservation_email_queue (to_email, subject, body, next_attempt_at)
  values (p_to_email, p_subject, p_body, v_next_day)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.claim_reservation_email()
returns table (id bigint, to_email text, subject text, body text)
language sql
security definer
set search_path = ''
as $$
  with candidate as (
    select q.id
      from public.reservation_email_queue q
     where (q.status = 'queued' and q.next_attempt_at <= pg_catalog.now())
        or (q.status = 'sending' and q.locked_until <= pg_catalog.now())
     order by q.created_at
     limit 1
     for update of q skip locked
  )
  update public.reservation_email_queue q
     set status = 'sending',
         attempts = q.attempts + 1,
         locked_until = pg_catalog.now() + interval '10 minutes'
    from candidate c
   where q.id = c.id
  returning q.id, q.to_email, q.subject, q.body;
$$;

create or replace function public.finish_reservation_email(
  p_id bigint,
  p_success boolean,
  p_daily_limit boolean,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next_day timestamptz :=
    (((pg_catalog.now() at time zone 'Asia/Singapore')::date + 1)::timestamp)
      at time zone 'Asia/Singapore';
begin
  if p_success then
    update public.reservation_email_queue
       set status = 'sent',
           sent_at = pg_catalog.now(),
           locked_until = null,
           last_error = null
     where id = p_id and status = 'sending';
  elsif p_daily_limit then
    update public.reservation_email_queue
       set status = 'queued',
           attempts = greatest(attempts - 1, 0),
           next_attempt_at = v_next_day,
           locked_until = null,
           last_error = null
     where id = p_id and status = 'sending';
  else
    update public.reservation_email_queue
       set status = case when attempts >= 5 then 'failed' else 'queued' end,
           next_attempt_at = pg_catalog.now() + interval '5 minutes' * least(attempts, 5),
           locked_until = null,
           last_error = pg_catalog.left(coalesce(p_error, 'Email delivery failed'), 2000)
     where id = p_id and status = 'sending';
  end if;
  return found;
end;
$$;

create or replace function public.dispatch_reservation_email_queue()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
  v_send_date date := (pg_catalog.now() at time zone 'Asia/Singapore')::date;
  v_sent_count integer;
begin
  if not exists (
    select 1
      from public.reservation_email_queue
     where (status = 'queued' and next_attempt_at <= pg_catalog.now())
        or (status = 'sending' and locked_until <= pg_catalog.now())
  ) then
    return;
  end if;

  select coalesce((
    select sent_count
      from public.gmail_email_daily_usage
     where send_date = v_send_date
  ), 0) into v_sent_count;
  if v_sent_count >= 500 then return; end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'reservation_email_webhook_secret';
  if v_secret is null then
    raise warning 'reservation_email_webhook_secret not found in Vault; reservation email queue paused';
    return;
  end if;

  perform net.http_post(
    url := 'https://egggnxmzxbqdsqqlnvig.supabase.co/functions/v1/send-reservation-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-reservation-email-secret', v_secret
    ),
    body := jsonb_build_object('action', 'drain-queue')
  );
end;
$$;

revoke all on function public.claim_gmail_email_quota(integer) from public, anon, authenticated;
revoke all on function public.enqueue_reservation_email(text, text, text) from public, anon, authenticated;
revoke all on function public.claim_reservation_email() from public, anon, authenticated;
revoke all on function public.finish_reservation_email(bigint, boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.dispatch_reservation_email_queue() from public, anon, authenticated;
grant execute on function public.claim_gmail_email_quota(integer) to service_role;
grant execute on function public.enqueue_reservation_email(text, text, text) to service_role;
grant execute on function public.claim_reservation_email() to service_role;
grant execute on function public.finish_reservation_email(bigint, boolean, boolean, text) to service_role;

select cron.unschedule(jobid)
  from cron.job
 where jobname = 'reservation-email-queue';

select cron.schedule(
  'reservation-email-queue',
  '*/5 * * * *',
  'select public.dispatch_reservation_email_queue();'
);

-- Generate the private website-management token in the database. The booking
-- page creates reservations through an RPC, so this guarantees the token is
-- stored even when the RPC does not accept a token argument.
create or replace function public.ensure_reservation_manage_token()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.branch in ('exclusive1', 'langnuong1980s', 'bodevegetarian')
     and nullif(btrim(new.manage_token), '') is null then
    new.manage_token := replace(pg_catalog.gen_random_uuid()::text, '-', '');
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_manage_token_before_insert on public.reservations;
create trigger reservations_manage_token_before_insert
  before insert on public.reservations
  for each row
  execute function public.ensure_reservation_manage_token();

create or replace function public.notify_reservation_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event text;
  v_secret text;
  v_previous jsonb;
begin
  if new.branch is null
     or new.branch not in ('exclusive1', 'langnuong1980s', 'bodevegetarian')
     or new.email is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_event := 'confirmation';
  elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    v_event := 'cancelled';
  elsif (new.reserved_date, new.reserved_time) is distinct from (old.reserved_date, old.reserved_time)
        and old.status is distinct from 'cancelled' then
    v_event := 'rescheduled';
    v_previous := jsonb_build_object(
      'reserved_date', old.reserved_date,
      'reserved_time', old.reserved_time
    );
  else
    return new;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'reservation_email_webhook_secret';

  if v_secret is null then
    raise warning 'reservation_email_webhook_secret not found in Vault; reservation email skipped';
    return new;
  end if;

  perform net.http_post(
    url := 'https://egggnxmzxbqdsqqlnvig.supabase.co/functions/v1/send-reservation-email',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-reservation-email-secret', v_secret
    ),
    body := jsonb_build_object(
      'event', v_event,
      'reservation', jsonb_build_object(
        'reference', new.reference,
        'branch', new.branch,
        'guest_name', new.guest_name,
        'email', new.email,
        'phone', new.phone,
        'notes', new.notes,
        'guests', new.guests,
        'reserved_date', new.reserved_date,
        'reserved_time', new.reserved_time,
        'duration', new.duration,
        'manage_token', new.manage_token
      ),
      'previous', v_previous
    )
  );

  return new;
end;
$$;

drop trigger if exists reservations_send_guest_email on public.reservations;
drop trigger if exists reservations_change_email on public.reservations;
drop trigger if exists reservations_confirmation_email on public.reservations;
drop trigger if exists reservations_update_email on public.reservations;

create trigger reservations_confirmation_email
  after insert on public.reservations
  for each row
  execute function public.notify_reservation_email();

create trigger reservations_update_email
  after update on public.reservations
  for each row
  execute function public.notify_reservation_email();
