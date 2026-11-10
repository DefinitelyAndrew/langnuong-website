-- Send reservation confirmations and changes through the send-reservation-email
-- Edge Function. Create reservation_email_webhook_secret in Supabase Vault first.
create extension if not exists pg_net with schema extensions;

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
