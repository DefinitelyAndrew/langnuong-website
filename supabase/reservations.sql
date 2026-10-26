-- Reservation storage for the Lang Nuong booking pages.
-- Paste this into Supabase → SQL Editor → New query → Run.
-- Safe to re-run: everything is guarded with IF NOT EXISTS / drop-then-create.

create table if not exists public.reservations (
  id            uuid primary key default gen_random_uuid(),
  reference     text not null unique,
  branch        text not null default 'exclusive1',
  guest_name    text not null,
  email         text not null,
  phone         text not null,
  guests        int  not null check (guests between 1 and 20),
  reserved_date date not null,
  reserved_time text not null,
  duration      text not null,
  notes         text,
  status        text not null default 'pending'
                check (status in ('pending', 'confirmed', 'cancelled')),
  created_at    timestamptz not null default now()
);

create index if not exists reservations_slot_idx
  on public.reservations (reserved_date, reserved_time);

create index if not exists reservations_email_idx
  on public.reservations (email);

alter table public.reservations enable row level security;

-- Visitors may create a booking. They must not be able to forge a status,
-- and they can never read, edit or delete anyone's booking.
drop policy if exists "anyone can create a reservation" on public.reservations;
create policy "anyone can create a reservation"
  on public.reservations
  for insert
  to anon, authenticated
  with check (status = 'pending');

-- No select / update / delete policies are defined on purpose: the table is only
-- readable from the Supabase dashboard, the service role, or a future staff view.
