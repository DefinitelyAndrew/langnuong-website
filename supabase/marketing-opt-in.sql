-- Marketing/promotions opt-in for reservations, plus portal tools to view
-- subscribers and send a mass email. Run in Supabase SQL Editor.

alter table public.reservations
  add column if not exists marketing_opt_in boolean not null default false;

-- Exclusive (BBQ & Exclusive) branch. Kept compatible with the public booking
-- page, which passes p_reference, p_guest_name, p_email, p_phone, p_guests,
-- p_reserved_date, p_reserved_time, p_notes (and now p_marketing_opt_in).
create or replace function public.reservation_create(
  p_reference text,
  p_guest_name text,
  p_email text,
  p_phone text,
  p_guests integer,
  p_reserved_date date,
  p_reserved_time text,
  p_duration text default '2h',
  p_notes text default null,
  p_marketing_opt_in boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot int;
begin
  if p_guests is null or p_guests < 1 or p_guests > 20 then
    raise exception 'Guest count must be between 1 and 20';
  end if;
  if p_reserved_time is null or p_reserved_time !~ '^([01][0-9]|2[0-3]):(00|30)$' then
    raise exception 'Reservation time must be on a 30-minute interval';
  end if;

  v_slot := (split_part(p_reserved_time, ':', 1)::int * 60) + split_part(p_reserved_time, ':', 2)::int;
  -- Exclusive: 15:00 to 06:00 (overnight)
  if not (v_slot >= 15 * 60 or v_slot < 6 * 60) then
    raise exception 'Reservation time is outside opening hours';
  end if;
  if (p_reserved_date + p_reserved_time::time) at time zone 'Asia/Singapore'
     < now() + interval '3 hours' then
    raise exception 'Reservation time must be at least 3 hours from now';
  end if;

  insert into public.reservations (
    reference, branch, guest_name, email, phone, guests,
    reserved_date, reserved_time, duration, notes, manage_token,
    marketing_opt_in, status, created_at, updated_at
  )
  values (
    p_reference, 'exclusive1', p_guest_name, p_email, p_phone, p_guests,
    p_reserved_date, p_reserved_time, coalesce(p_duration, '2h'), p_notes, null,
    coalesce(p_marketing_opt_in, false), 'confirmed', now(), now()
  );
end;
$$;

grant execute on function public.reservation_create(
  text, text, text, text, integer, date, text, text, text, boolean
) to anon, authenticated;

-- 1980's and Bo De branches.
create or replace function public.reservation_create_for_branch(
  p_branch text,
  p_reference text,
  p_guest_name text,
  p_email text,
  p_phone text,
  p_guests integer,
  p_reserved_date date,
  p_reserved_time text,
  p_duration text default '2h',
  p_notes text default null,
  p_marketing_opt_in boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_open int;
  v_close int;
  v_slot int;
begin
  if p_branch is null
     or p_branch not in ('exclusive1', 'langnuong1980s', 'bodevegetarian') then
    raise exception 'Unsupported reservation branch';
  end if;
  if p_guests is null or p_guests < 1 or p_guests > 20 then
    raise exception 'Guest count must be between 1 and 20';
  end if;
  if p_reserved_time is null or p_reserved_time !~ '^([01][0-9]|2[0-3]):(00|30)$' then
    raise exception 'Reservation time must be on a 30-minute interval';
  end if;

  v_slot := (split_part(p_reserved_time, ':', 1)::int * 60) + split_part(p_reserved_time, ':', 2)::int;
  if p_branch = 'exclusive1' then v_open := 15 * 60; v_close := 6 * 60;
  else v_open := 10 * 60; v_close := 22 * 60;
  end if;
  if v_close <= v_open then
    if not (v_slot >= v_open or v_slot < v_close) then
      raise exception 'Reservation time is outside opening hours';
    end if;
  else
    if not (v_slot >= v_open and v_slot < v_close) then
      raise exception 'Reservation time is outside opening hours';
    end if;
  end if;
  if (p_reserved_date + p_reserved_time::time) at time zone 'Asia/Singapore'
     < now() + interval '3 hours' then
    raise exception 'Reservation time must be at least 3 hours from now';
  end if;

  insert into public.reservations (
    reference, branch, guest_name, email, phone, guests,
    reserved_date, reserved_time, duration, notes, manage_token,
    marketing_opt_in, status, created_at, updated_at
  )
  values (
    p_reference, p_branch, p_guest_name, p_email, p_phone, p_guests,
    p_reserved_date, p_reserved_time, coalesce(p_duration, '2h'), p_notes, null,
    coalesce(p_marketing_opt_in, false), 'confirmed', now(), now()
  );
end;
$$;

grant execute on function public.reservation_create_for_branch(
  text, text, text, text, text, integer, date, text, text, text, boolean
) to anon, authenticated;

-- Distinct emails of guests who opted in to promotions/news. Staff-only.
create or replace function public.portal_list_marketing_subscribers()
returns table (email text, latest_name text, latest_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.portal_email_allowed(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'Not authorized';
  end if;

  return query
    select distinct on (lower(r.email))
           r.email,
           r.guest_name as latest_name,
           r.created_at as latest_at
      from public.reservations r
     where coalesce(r.marketing_opt_in, false) = true
       and r.email is not null
       and btrim(r.email) <> ''
     order by lower(r.email), r.created_at desc;
end;
$$;

revoke all on function public.portal_list_marketing_subscribers() from public, anon;
grant execute on function public.portal_list_marketing_subscribers() to authenticated;

-- Service-role helper for the edge function.
create or replace function public.portal_list_marketing_subscribers_for_send()
returns table (email text, latest_name text, latest_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (lower(r.email))
         r.email,
         r.guest_name as latest_name,
         r.created_at as latest_at
    from public.reservations r
   where coalesce(r.marketing_opt_in, false) = true
     and r.email is not null
     and btrim(r.email) <> ''
   order by lower(r.email), r.created_at desc;
$$;

revoke all on function public.portal_list_marketing_subscribers_for_send() from public, anon, authenticated;
grant execute on function public.portal_list_marketing_subscribers_for_send() to service_role;
