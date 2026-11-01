-- Trigger that adds each exclusive1 reservation to Google Calendar and emails the
-- guest a .ics file + a link to the calendar entry. Runs in the Supabase function
-- sandbox, so the action is a single Edge Function call, not two.
create extension if not exists pg_net with schema extensions;

create or replace function public.reservation_auto_add_to_calendar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.branch = 'exclusive1' then
    perform net.http_post(
      url := 'https://egggnxmzxbqdsqqlnvig.supabase.co/functions/v1/add-reservation-to-calendar',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
      ),
      body := jsonb_build_object(
        'reservation', jsonb_build_object(
          'reference', new.reference,
          'branch', new.branch,
          'guest_name', new.guest_name,
          'email', new.email,
          'phone', new.phone,
          'guests', new.guests,
          'reserved_date', new.reserved_date,
          'reserved_time', new.reserved_time,
          'duration', new.duration
        )
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_add_to_google_calendar on public.reservations;
create trigger reservations_add_to_google_calendar
  after insert on public.reservations
  for each row
  execute function public.reservation_auto_add_to_calendar();
