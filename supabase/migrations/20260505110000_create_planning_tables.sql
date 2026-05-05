-- Migration to create plannings, conges, and rotation_state tables

create table if not exists public.plannings (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  annee integer not null,
  mois integer not null,
  groupe_id text not null, -- Stores the group code (e.g., 'medecins', 'paramedical')
  ordre_equipes jsonb not null default '["A", "B", "C", "D"]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint plannings_service_annee_mois_groupe_key unique (service_id, annee, mois, groupe_id)
);

create index if not exists plannings_service_annee_mois_idx on public.plannings(service_id, annee, mois);

create table if not exists public.conges (
  id uuid primary key default gen_random_uuid(),
  planning_id uuid not null references public.plannings(id) on delete cascade,
  membre_index integer not null,
  membre_nom text not null,
  membre_equipe text,
  jour integer not null,
  code text not null,
  is_auto boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists conges_planning_id_idx on public.conges(planning_id);

create table if not exists public.rotation_state (
  service_id uuid not null references public.services(id) on delete cascade,
  annee integer not null,
  mois integer not null,
  equipe_debut text not null,
  ordre_equipes jsonb not null default '["A", "B", "C", "D"]'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (service_id, annee, mois)
);

grant select, insert, update, delete on public.plannings to anon;
grant select, insert, update, delete on public.plannings to authenticated;
grant select, insert, update, delete on public.conges to anon;
grant select, insert, update, delete on public.conges to authenticated;
grant select, insert, update, delete on public.rotation_state to anon;
grant select, insert, update, delete on public.rotation_state to authenticated;
