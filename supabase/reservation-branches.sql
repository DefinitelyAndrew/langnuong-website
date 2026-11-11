-- Branch-aware reservation creation for the public booking pages.
-- Run this after reservations.sql; reservation-emails.sql generates each
-- reservation's management token in its BEFORE INSERT trigger.
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
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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

  -- Enforce each branch's opening hours (Asia/Singapore local time).
  declare
    v_open int;
    v_close int;
    v_slot int;
  begin
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
  end;
  if (p_reserved_date + p_reserved_time::time) at time zone 'Asia/Singapore'
     < now() + interval '3 hours' then
    raise exception 'Reservation time must be at least 3 hours from now';
  end if;

  insert into public.reservations (
    reference,
    branch,
    guest_name,
    email,
    phone,
    guests,
    reserved_date,
    reserved_time,
    duration,
    notes,
    manage_token,
    status,
    created_at,
    updated_at
  )
  values (
    p_reference,
    p_branch,
    p_guest_name,
    p_email,
    p_phone,
    p_guests,
    p_reserved_date,
    p_reserved_time,
    p_duration,
    p_notes,
    null,
    'confirmed',
    now(),
    now()
  );
end;
$$;

grant execute on function public.reservation_create_for_branch(
  text, text, text, text, text, integer, date, text, text, text
) to anon, authenticated;
