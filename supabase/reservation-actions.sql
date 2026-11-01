-- Reservation storage and confirmation email (database-side side effect).
-- Run after supabase/reservations.sql in Supabase → SQL Editor.

-- Fires when a row's status becomes 'cancelled' or its date/time moves, and POSTs
-- to Gmail's SMTP API using the `gmail_smtp_password` stored in Supabase Vault.
-- The message goes only to the guest. Delivery is best-effort: any failure below
-- is logged as a warning and never blocks the cancel/reschedule itself.
--
-- Before running: create the two Gmail templates (see README.md section 1) and put
-- their IDs on the `v_template := ...;` lines below.

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
    v_template := 3;  -- Gmail template ID for the [Cancel] message
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
    v_template := 4;  -- Gmail template ID for the [Reschedule] message
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
     where name = 'gmail_smtp_password';

    if v_api_key is null then
      raise warning 'gmail_smtp_password not found in Vault; reservation email skipped';
      return new;
    end if;

    perform net.http_post(
      url     := 'smtps://smtp.gmail.com:587',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Basic ' || encode(convert_from(decrypt('gmail_smtp_password', v_api_key), 'utf8'), 'base64')
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
