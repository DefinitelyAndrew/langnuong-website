-- Lookup, cancel and reschedule for a single reservation, addressed by manage_token.
-- Run after reservations.sql (safe to re-run; also upgrades an older table).

alter table public.reservations add column if not exists manage_token   text;
alter table public.reservations add column if not exists reserved_label text;
alter table public.reservations add column if not exists updated_at     timestamptz default now();

create unique index if not exists reservations_token_idx
  on public.reservations (manage_token);

-- All bookings are Asia/Singapore wall-clock times; compare in that zone rather than
-- the project default (UTC) so the 3-hour rule and "in the past" checks are correct.
create or replace function public.reservation_slot_ts(p_date date, p_time text)
returns timestamptz
language sql
immutable
as $$ select (p_date + p_time::time) at time zone 'Asia/Singapore' $$;

create or replace function public.reservation_get(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r public.reservations;
begin
  if p_token is null or length(p_token) < 16 then return null; end if;
  select * into r from public.reservations where manage_token = p_token;
  if not found then return null; end if;
  return jsonb_build_object(
    'reference', r.reference,
    'branch', r.branch,
    'guest_name', r.guest_name,
    'guests', r.guests,
    'reserved_date', r.reserved_date,
    'reserved_time', r.reserved_time,
    'duration', r.duration,
    'notes', r.notes,
    'status', r.status
  );
end;
$$;

create or replace function public.reservation_cancel(p_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare r public.reservations;
begin
  if p_token is null or length(p_token) < 16 then return 'not_found'; end if;
  select * into r from public.reservations where manage_token = p_token for update;
  if not found then return 'not_found'; end if;
  if r.status = 'cancelled' then return 'already_cancelled'; end if;
  if public.reservation_slot_ts(r.reserved_date, r.reserved_time) < now() then return 'in_past'; end if;
  update public.reservations
     set status = 'cancelled', updated_at = now()
   where id = r.id;
  return 'cancelled';
end;
$$;

create or replace function public.reservation_reschedule(p_token text, p_date date, p_time text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare r public.reservations;
begin
  if p_token is null or length(p_token) < 16 then return 'not_found'; end if;
  if p_time is null or p_time !~ '^[0-2][0-9]:[0-5][0-9]$' then return 'invalid_time'; end if;
  select * into r from public.reservations where manage_token = p_token for update;
  if not found then return 'not_found'; end if;
  if r.status = 'cancelled' then return 'cancelled'; end if;
  if public.reservation_slot_ts(p_date, p_time) < now() + interval '3 hours' then return 'too_soon'; end if;
  update public.reservations
     set reserved_date  = p_date,
         reserved_time  = p_time,
         reserved_label = to_char(p_date, 'FMDay, FMDD FMMonth YYYY'),
         updated_at     = now()
   where id = r.id;
  return 'rescheduled';
end;
$$;

-- Only these three entry points are callable by a visitor; the table itself stays closed.
revoke all on function public.reservation_get(text)                       from public;
revoke all on function public.reservation_cancel(text)                    from public;
revoke all on function public.reservation_reschedule(text, date, text)    from public;

grant execute on function public.reservation_get(text)                     to anon, authenticated;
grant execute on function public.reservation_cancel(text)                  to anon, authenticated;
grant execute on function public.reservation_reschedule(text, date, text)  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cancel / reschedule emails
--
-- Fires when a row's status becomes 'cancelled' or its date/time moves, and POSTs
-- to Brevo's transactional API using the `brevo_api_key` stored in Supabase Vault.
-- The message goes to the guest only. Delivery is best-effort: any failure below is
-- logged as a warning and never blocks the cancel/reschedule itself.
--
-- Before running: create the two Brevo templates (see supabase/README.md section 6)
-- and put their IDs on the `v_template := ...` lines below.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

create or replace function public.reservation_change_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template integer;
  v_params   jsonb;
  v_api_key  text;
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if new.email is null then return new; end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    v_template := 3;  -- Brevo template ID for the [Cancel] message
    v_params := jsonb_build_object(
      'reference',  new.reference,
      'address',    '271 Jalan Besar, Singapore',
      'old_date',   coalesce(nullif(old.reserved_label, ''), to_char(old.reserved_date, 'FMDay, FMDD FMMonth YYYY')),
      'old_time',   old.reserved_time,
      'guests',     old.guests::text,
      'cancel_url', 'https://definitelyandrew.github.io/langnuong-website/reservations/manage/cancel.html?t=' || old.manage_token
    );
  elsif (new.reserved_date, new.reserved_time) is distinct from (old.reserved_date, old.reserved_time)
        and old.status is distinct from 'cancelled' then
    v_template := 4;  -- Brevo template ID for the [Reschedule] message
    v_params := jsonb_build_object(
      'reference',       new.reference,
      'address',         '271 Jalan Besar, Singapore',
      'old_date',        coalesce(nullif(old.reserved_label, ''), to_char(old.reserved_date, 'FMDay, FMDD FMMonth YYYY')),
      'old_time',        old.reserved_time,
      'new_date',        coalesce(nullif(new.reserved_label, ''), to_char(new.reserved_date, 'FMDay, FMDD FMMonth YYYY')),
      'new_time',        new.reserved_time,
      'guests',          new.guests::text,
      'reschedule_url',  'https://definitelyandrew.github.io/langnuong-website/reservations/manage/reschedule.html?t=' || new.manage_token,
      'cancel_url',      'https://definitelyandrew.github.io/langnuong-website/reservations/manage/cancel.html?t=' || new.manage_token
    );
  else
    return new;
  end if;

  begin
    select decrypted_secret into v_api_key
      from vault.decrypted_secrets
     where name = 'brevo_api_key';

    if v_api_key is null then
      raise warning 'brevo_api_key not found in Vault; reservation email skipped';
      return new;
    end if;

    perform net.http_post(
      url     := 'https://api.brevo.com/v3/smtp/email',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'api-key', v_api_key
      ),
      body    := jsonb_build_object(
        'to',         jsonb_build_array(jsonb_build_object('email', new.email, 'name', new.guest_name)),
        'templateId', v_template,
        'params',     v_params
      )
    );
  exception when others then
    raise warning 'reservation email not sent: %', sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists reservations_change_email on public.reservations;
create trigger reservations_change_email
  after update on public.reservations
  for each row
  execute function public.reservation_change_email();
