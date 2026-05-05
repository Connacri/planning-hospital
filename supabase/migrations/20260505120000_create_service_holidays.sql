-- Migration to create service_holidays table

create table if not exists public.service_holidays (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  mois integer not null check (mois >= 1 and mois <= 12),
  jour integer not null check (jour >= 1 and jour <= 31),
  label text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique(service_id, mois, jour)
);

create index if not exists service_holidays_service_id_idx on public.service_holidays(service_id);

grant select, insert, update, delete on public.service_holidays to anon;
grant select, insert, update, delete on public.service_holidays to authenticated;
