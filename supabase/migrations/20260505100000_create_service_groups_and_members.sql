create table if not exists public.service_groups (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.services(id) on delete cascade,
  code text not null,
  label text not null,
  subtitle text not null default '',
  color text not null default '#64748b',
  has_equipe boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint service_groups_service_id_code_key unique (service_id, code)
);

create index if not exists service_groups_service_id_sort_order_idx
  on public.service_groups(service_id, sort_order);

create table if not exists public.service_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.service_groups(id) on delete cascade,
  nom text not null,
  grade text not null default '',
  equipe text,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint service_members_equipe_check
    check (equipe is null or equipe in ('A', 'B', 'C', 'D'))
);

create index if not exists service_members_group_id_sort_order_idx
  on public.service_members(group_id, sort_order);

grant select, insert, update, delete on public.service_groups to anon;
grant select, insert, update, delete on public.service_groups to authenticated;
grant select, insert, update, delete on public.service_members to anon;
grant select, insert, update, delete on public.service_members to authenticated;

create or replace function public.seed_service_defaults(target_service_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  medecins_id uuid;
  surveillance_id uuid;
  paramedical_jour_id uuid;
  administratifs_id uuid;
  paramedical_id uuid;
  hygiene_id uuid;
begin
  if target_service_id is null then
    raise exception 'target_service_id is required';
  end if;

  if exists (
    select 1
    from public.service_groups
    where service_id = target_service_id
  ) then
    return;
  end if;

  -- 1. Groupe Médecins
  insert into public.service_groups (service_id, code, label, subtitle, color, has_equipe, sort_order)
  values (target_service_id, 'medecins', '🩺 Médecins', 'Praticiens Spécialistes', '#3b82f6', false, 0)
  returning id into medecins_id;

  -- 2. Groupe Surveillance & Encadrement
  insert into public.service_groups (service_id, code, label, subtitle, color, has_equipe, sort_order)
  values (target_service_id, 'surveillance', '📋 Surveillance', 'Encadrement & I.SSP', '#f43f5e', false, 1)
  returning id into surveillance_id;

  -- 3. Groupe Paramedical Jour
  insert into public.service_groups (service_id, code, label, subtitle, color, has_equipe, sort_order)
  values (target_service_id, 'paramedical_jour', '🏥 Para. Jour', 'Psychologue & Aide Soignante', '#10b981', false, 2)
  returning id into paramedical_jour_id;

  -- 4. Groupe Administration
  insert into public.service_groups (service_id, code, label, subtitle, color, has_equipe, sort_order)
  values (target_service_id, 'administratifs', '🗂️ Administration', 'Secrétariat & Technique', '#8b5cf6', false, 3)
  returning id into administratifs_id;

  -- 5. Groupe Rotation Paramédical (Garde 24h)
  insert into public.service_groups (service_id, code, label, subtitle, color, has_equipe, sort_order)
  values (target_service_id, 'paramedical', '🔄 Para. Garde', 'Rotation 24h', '#06b6d4', true, 4)
  returning id into paramedical_id;

  -- 6. Groupe Hygiène
  insert into public.service_groups (service_id, code, label, subtitle, color, has_equipe, sort_order)
  values (target_service_id, 'hygiene', '🧹 Hygiène', 'Rotation 24h', '#f59e0b', true, 5)
  returning id into hygiene_id;

  -- Insert Demo Members
  insert into public.service_members (group_id, nom, grade, equipe, sort_order)
  values 
    (medecins_id, 'Dr. BENALI Karim', 'Médecin Rhumatologue', null, 0),
    (medecins_id, 'Dr. MAMMERI Salima', 'Médecin Généraliste', null, 1),
    (medecins_id, 'Dr. KACI Omar', 'Médecin Spécialiste', null, 2),
    
    (surveillance_id, 'BELHADJ Sonia', 'Surveillant Médical', null, 0),
    (surveillance_id, 'BOUABDALLAH Ali', 'I.SSP', null, 1),

    (paramedical_jour_id, 'ZAHI Fatiha', 'Psychologue', null, 0),
    (paramedical_jour_id, 'RAIS Houria', 'Aide Soignante', null, 1),

    (administratifs_id, 'BOUZIANE Karima', 'Secrétaire Médicale', null, 0),
    (administratifs_id, 'MEDJDOUB Sofiane', 'Technicien Adm.', null, 1),

    (paramedical_id, 'HAMDI Nadia', 'Infirmier Principal', 'A', 0),
    (paramedical_id, 'MEZIANI Youcef', 'Infirmier', 'B', 1),
    (paramedical_id, 'BRAHIMI Fatima', 'Infirmière', 'C', 2),
    (paramedical_id, 'AISSAOUI Rachid', 'Infirmier', 'D', 3),

    (hygiene_id, 'OULD ALI Nassima', 'Agent d''Hygiène', 'A', 0),
    (hygiene_id, 'FERHAT Mourad', 'Agent d''Hygiène', 'B', 1),
    (hygiene_id, 'ZIANI Amine', 'Agent d''Hygiène', 'C', 2),
    (hygiene_id, 'BELKACEM Samia', 'Agent d''Hygiène', 'D', 3)
  on conflict do nothing;
end;
$$;

grant execute on function public.seed_service_defaults(uuid) to anon;
grant execute on function public.seed_service_defaults(uuid) to authenticated;

create or replace function public.handle_service_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_service_defaults(new.id);
  return new;
end;
$$;

drop trigger if exists service_seed_defaults on public.services;

create trigger service_seed_defaults
after insert on public.services
for each row
execute function public.handle_service_defaults();

insert into public.services (id, code, nom, etablissement)
values (
  'd57fe703-bc10-482b-91b4-d532ac31bfa4',
  'RHUMA01',
  'Service de Rhumatologie',
  'EH Aïn El Türck - Dr. Medjber Tami'
)
on conflict (code) do update
set
  nom = excluded.nom,
  etablissement = excluded.etablissement;

select public.seed_service_defaults('d57fe703-bc10-482b-91b4-d532ac31bfa4'::uuid);
