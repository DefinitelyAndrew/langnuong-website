-- Run this once in Supabase SQL Editor.
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  items jsonb not null,
  total numeric(10, 2) not null check (total >= 0),
  status text not null default 'request_sent',
  created_at timestamptz not null default now()
);

alter table public.orders enable row level security;

grant select, insert on table public.orders to authenticated;

drop policy if exists "Users can view their own orders" on public.orders;
drop policy if exists "Users can create their own orders" on public.orders;

create policy "Users can view their own orders"
on public.orders for select
to authenticated
using (auth.uid() = user_id);

create policy "Users can create their own orders"
on public.orders for insert
to authenticated
with check (auth.uid() = user_id);
