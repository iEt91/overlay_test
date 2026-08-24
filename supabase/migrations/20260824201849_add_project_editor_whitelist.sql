-- Lista de cuentas Twitch autorizadas por el streamer para aceptar una
-- invitación. El enlace y la contraseña no alcanzan por sí solos.
create table public.project_editor_whitelist (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  twitch_login text not null check (twitch_login = lower(twitch_login)),
  created_by_twitch_id text not null references public.twitch_users(twitch_id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (project_id, twitch_login)
);

create index project_editor_whitelist_project_idx
  on public.project_editor_whitelist(project_id, twitch_login);

-- La lista sólo se administra desde server.js con la clave de servicio.
revoke all on table public.project_editor_whitelist from anon, authenticated;
alter table public.project_editor_whitelist enable row level security;
