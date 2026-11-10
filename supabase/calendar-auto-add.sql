-- Sync exclusive1 reservations with the restaurant's Google Calendar.
-- Deploy add-reservation-to-calendar and configure its Google service account first.
create extension if not exists pg_net with schema extensions;

create or replace function public.sync_reservation_to_google_calendar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event text;
  v_secret text;
  v_reservation public.reservations%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.branch <> 'exclusive1' then return old; end if;
    v_event := 'delete';
    v_reservation := old;
  elsif tg_op = 'INSERT' then
    if new.branch <> 'exclusive1' or new.status = 'cancelled' then return new; end if;
    v_event := 'upsert';
    v_reservation := new;
  elsif old.branch = 'exclusive1'
        and (new.branch <> 'exclusive1'
             or (new.status = 'cancelled' and old.status is distinct from 'cancelled')) then
    v_event := 'delete';
    v_reservation := old;
  elsif new.branch = 'exclusive1'
        and new.status <> 'cancelled'
        and (
          old.branch is distinct from new.branch
          or old.status is distinct from new.status
          or (old.reserved_date, old.reserved_time, old.duration, old.guests, old.email, old.phone)
             is distinct from
             (new.reserved_date, new.reserved_time, new.duration, new.guests, new.email, new.phone)
        ) then
    v_event := 'upsert';
    v_reservation := new;
  else
    return new;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'reservation_email_webhook_secret';

  if v_secret is null then
    raise warning 'reservation_email_webhook_secret not found in Vault; calendar sync skipped';
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  perform net.http_post(
    url := 'https://egggnxmzxbqdsqqlnvig.supabase.co/functions/v1/add-reservation-to-calendar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-reservation-webhook-secret', v_secret
    ),
    body := jsonb_build_object(
      'event', v_event,
      'reservation', jsonb_build_object(
        'reference', v_reservation.reference,
        'branch', v_reservation.branch,
        'email', v_reservation.email,
        'phone', v_reservation.phone,
        'guests', v_reservation.guests,
        'reserved_date', v_reservation.reserved_date,
        'reserved_time', v_reservation.reserved_time,
        'duration', v_reservation.duration
      )
    )
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists reservations_add_to_google_calendar on public.reservations;
drop trigger if exists reservations_calendar_sync on public.reservations;
create trigger reservations_calendar_sync
  after insert or update or delete on public.reservations
  for each row
  execute function public.sync_reservation_to_google_calendar();
