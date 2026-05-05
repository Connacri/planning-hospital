-- Migration to create service_leave_types table

create table if not exists public.service_leave_types (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  code text not null,
  label text not null,
  color text not null default '#3b82f6',
  is_default boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique(service_id, code)
);

-- Grant permissions
grant select, insert, update, delete on public.service_leave_types to anon;
grant select, insert, update, delete on public.service_leave_types to authenticated;

-- Function to seed default leave types for a service
create or replace function public.seed_service_leave_types(target_service_id uuid)
returns void as $$
begin
  insert into public.service_leave_types (service_id, code, label, color, is_default, sort_order)
  values
    (target_service_id, 'G',  'Garde',         '#ef4444', true, 10),
    (target_service_id, 'RE', 'Récupération',  '#f97316', true, 20),
    (target_service_id, 'C',  'Congé',         '#3b82f6', true, 30),
    (target_service_id, 'CM', 'C. Maladie',    '#a855f7', true, 40),
    (target_service_id, 'M',  'Maternité',     '#ec4899', true, 50),
    (target_service_id, 'N',  'Normal',        '#22c55e', true, 60),
    (target_service_id, 'F',  'Férié',         '#06b6d4', true, 70)
  on conflict (service_id, code) do nothing;
end;
$$ language plpgsql;
