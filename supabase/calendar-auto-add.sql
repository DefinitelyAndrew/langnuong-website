-- Auto-add exclusive reservations to Google Calendar
-- Run this after deploying the Edge Function

-- Enable pg_net if not already enabled
create extension if not exists pg_net with schema extensions;

-- Function to call the Edge Function
create or replace function public.add_reservation_to_google_calendar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Only for exclusive1 branch
  if new.branch = 'exclusive1' then
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
  end if;
  return new;
end;
$$;

-- Create trigger
drop trigger if exists reservations_add_to_google_calendar on public.reservations;
create trigger reservations_add_to_google_calendar
  after insert on public.reservations
  for each row
  execute function public.add_reservation_to_google_calendar();
