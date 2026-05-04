-- WARNING:
-- This stores third-party API keys in plaintext for a public client app.
-- With the current anonymous-access architecture, this is convenient but not secure.
-- For production, prefer authenticated users plus RLS or an Edge Function that stores
-- secrets server-side.

create table if not exists public.service_ai_settings (
  service_id uuid not null references public.services(id) on delete cascade,
  provider text not null,
  api_key text not null,
  api_key_hint text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (service_id, provider)
);

grant select, insert, update, delete on public.service_ai_settings to anon;
grant select, insert, update, delete on public.service_ai_settings to authenticated;
