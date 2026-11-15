-- Staff-managed short links for the portal.
-- Run in the Supabase SQL editor.

create table if not exists public.portal_shortlinks (
  id           bigserial primary key,
  slug         text not null unique,
  destination_url text not null,
  label        text,
  created_by   text,
  clicks       integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists portal_shortlinks_created_at_idx
  on public.portal_shortlinks (created_at desc);

alter table public.portal_shortlinks enable row level security;
revoke all on table public.portal_shortlinks from public, anon, authenticated;

create or replace function public.portal_list_shortlinks(p_limit integer default 200)
returns table (
  slug            text,
  destination_url text,
  label           text,
  clicks          integer,
  created_at      timestamptz,
  created_by      text
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
    select s.slug, s.destination_url, s.label, s.clicks, s.created_at, s.created_by
      from public.portal_shortlinks s
     order by s.created_at desc
     limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;

revoke all on function public.portal_list_shortlinks(integer) from public, anon;
grant execute on function public.portal_list_shortlinks(integer) to authenticated;

drop function if exists public.portal_create_shortlink(text, text, text);
create or replace function public.portal_create_shortlink(
  p_destination_url text,
  p_slug text,
  p_label text
)
returns table (slug text, destination_url text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text;
  v_dest text;
  v_label text;
  v_email text;
begin
  v_email := coalesce(auth.jwt() ->> 'email', '');
  if not public.portal_email_allowed(v_email) then
    raise exception 'Not authorized';
  end if;

  v_dest := btrim(coalesce(p_destination_url, ''));
  if v_dest = '' then
    raise exception 'Destination URL is required';
  end if;
  if v_dest !~* '^https?://' then
    raise exception 'Destination URL must start with http:// or https://';
  end if;
  if char_length(v_dest) > 2000 then
    raise exception 'Destination URL is too long';
  end if;

  v_label := nullif(btrim(coalesce(p_label, '')), '');
  if v_label is null then
    raise exception 'Label is required';
  end if;
  if char_length(v_label) > 120 then
    raise exception 'Label is too long';
  end if;

  v_slug := lower(btrim(coalesce(p_slug, '')));
  if v_slug = '' or v_slug is null then
    raise exception 'Custom code is required';
  end if;
  if v_slug !~ '^[a-z0-9][a-z0-9_-]{1,62}$' then
    raise exception 'Custom code may use letters, numbers, - and _, and must be 2-63 characters';
  end if;

  insert into public.portal_shortlinks (slug, destination_url, label, created_by)
  values (v_slug, v_dest, v_label, v_email)
  returning portal_shortlinks.slug, portal_shortlinks.destination_url
    into slug, destination_url;
  return next;
end;
$$;

revoke all on function public.portal_create_shortlink(text, text, text) from public, anon;
grant execute on function public.portal_create_shortlink(text, text, text) to authenticated;

create or replace function public.portal_delete_shortlink(p_slug text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text;
begin
  if not public.portal_email_allowed(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'Not authorized';
  end if;
  v_slug := lower(btrim(coalesce(p_slug, '')));
  delete from public.portal_shortlinks where slug = v_slug;
  return found;
end;
$$;

revoke all on function public.portal_delete_shortlink(text) from public, anon;
grant execute on function public.portal_delete_shortlink(text) to authenticated;

-- Public resolver used by go/index.html. Returns the destination and counts the click.
create or replace function public.shortlink_resolve(p_slug text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text;
  v_dest text;
begin
  v_slug := lower(btrim(coalesce(p_slug, '')));
  if v_slug = '' then
    return null;
  end if;

  update public.portal_shortlinks
     set clicks = clicks + 1
   where slug = v_slug
  returning destination_url into v_dest;

  return v_dest;
end;
$$;

revoke all on function public.shortlink_resolve(text) from public, authenticated;
grant execute on function public.shortlink_resolve(text) to anon;

-- After running or re-running this file, refresh the API schema cache:
-- notify pgrst, 'reload schema';
