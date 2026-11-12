-- Staff portal access.
-- Only emails in public.portal_allowed_emails can receive a portal OTP and read
-- the reservation list. Add or remove staff emails with the insert/delete
-- statements at the bottom, then run this file in the Supabase SQL Editor.

create table if not exists public.portal_allowed_emails (
  email      text primary key,
  created_at timestamptz not null default now()
);

alter table public.portal_allowed_emails enable row level security;
revoke all on table public.portal_allowed_emails from public, anon, authenticated;

create or replace function public.portal_email_allowed(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.portal_allowed_emails
     where lower(email) = lower(btrim(coalesce(p_email, '')))
  );
$$;

revoke all on function public.portal_email_allowed(text) from public, anon, authenticated;
grant execute on function public.portal_email_allowed(text) to service_role;

-- Called by the signed-in portal page. Returns false for any email that is not
-- on the allowlist, including ordinary shop accounts.
create or replace function public.portal_check_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.portal_email_allowed(coalesce(auth.jwt() ->> 'email', ''));
$$;

revoke all on function public.portal_check_access() from public, anon;
grant execute on function public.portal_check_access() to authenticated;

-- Read-only reservation list for the staff portal. The authorization check is
-- repeated here so the table itself never needs a select policy.
create or replace function public.portal_list_reservations(p_limit integer default 200)
returns table (
  reference     text,
  branch        text,
  guest_name    text,
  email         text,
  phone         text,
  guests        integer,
  reserved_date date,
  reserved_time text,
  status        text,
  notes         text,
  created_at    timestamptz
)
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
    select r.reference,
           r.branch,
           r.guest_name,
           r.email,
           r.phone,
           r.guests,
           r.reserved_date,
           r.reserved_time,
           r.status,
           r.notes,
           r.created_at
      from public.reservations r
     order by r.reserved_date desc, r.reserved_time desc, r.created_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;

revoke all on function public.portal_list_reservations(integer) from public, anon;
grant execute on function public.portal_list_reservations(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Add the staff emails. Replace the example address before running.
-- ---------------------------------------------------------------------------
insert into public.portal_allowed_emails (email)
values ('andrewzhaoyunlong79@gmail.com')
on conflict (email) do nothing;

-- To add another:
-- insert into public.portal_allowed_emails (email) values ('staff@example.com')
-- on conflict (email) do nothing;

-- To remove access:
-- delete from public.portal_allowed_emails where lower(email) = lower('staff@example.com');
