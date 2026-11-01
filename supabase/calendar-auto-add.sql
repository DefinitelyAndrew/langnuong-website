-- Auto-add exclusive reservations to Google Calendar
-- Run this after deploying the Edge Function

-- Enable pg_net if not already enabled
create extension if not exists pg_net with schema extensions;

-- Function to call the Edge Function. Runs once per booking, only for the
exclusive1 branch, and only if the secret is present.
create or replace function public.add_reservation_to_google_calendar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.branch <> 'exclusive1' then return new; end if;

  perform net.http_post(
    url := 'https://egggnxmzxbqdsqqlnvig.supabase.co/functions/v1/add-reservation-to-calendar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := jsonb_build_object('reservation', jsonb_build_object(
      'reference', new.reference,
      'branch', new.branch,
      'guest_name', new.guest_name,
      'email', new.email,
      'phone', new.phone,
      'guests', new.guests,
      'reserved_date', new.reserved_date,
      'reserved_time', new.reserved_time,
      'duration', new.duration
    ))
  );

  return new;
end;
$$;

-- Create trigger (restaurant-side: add to Google Calendar)
drop trigger if exists reservations_add_to_google_calendar on public.reservations;
create trigger reservations_add_to_google_calendar
  after insert on public.reservations
  for each row
  execute function public.add_reservation_to_google_calendar();

-- Guest-side: email the booker a link to the calendar entry.
-- Runs after reservations_add_to_google_calendar, so the guest only gets an email
-- if the calendar add ran.
create extension if not exists pg_net with schema extensions;

create or replace function public.reservation_send_guest_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.branch <> 'exclusive1' then return new; end if;

  perform net.http_post(
    url     := 'https://egggnxmzxbqdsqqlnvig.supabase.co/functions/v1/add-reservation-to-calendar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('reservation', jsonb_build_object(
      'reference', new.reference,
      'branch', new.branch,
      'guest_name', new.guest_name,
      'email', new.email,
      'phone', new.phone,
      'guests', new.guests,
      'reserved_date', new.reserved_date,
      'reserved_time', new.reserved_time,
      'duration', new.duration
    ))
  );

  return new;
end;
$$;

drop trigger if exists reservations_send_guest_email on public.reservations;
create trigger reservations_send_guest_email
  after insert on public.reservations
  for each row
  execute function public.reservation_send_guest_email();
