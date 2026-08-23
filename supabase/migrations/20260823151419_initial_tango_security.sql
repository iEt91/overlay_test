-- Tango GG: una escena pertenece a un streamer y permite hasta dos invitados.
-- El navegador no accede a estas tablas directamente: server.js autoriza cada acción.

create type public.project_role as enum ('owner', 'editor');

create type public.subscription_status as enum (
  'trialing',
  'active',
  'past_due',
  'canceled',
  'suspended'
);

create table public.twitch_users (
  twitch_id text primary key,
  login text not null,
  display_name text not null,
  profile_image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_twitch_id text not null unique references public.twitch_users(twitch_id) on delete restrict,
  twitch_channel_id text not null,
  twitch_channel_login text not null,
  viewer_token_hash char(64) not null unique,
  viewer_token_created_at timestamptz not null default now(),
  overlay_enabled boolean not null default true,
  chat_enabled boolean not null default false,
  stream_preview_enabled boolean not null default true,
  subscription_status public.subscription_status not null default 'trialing',
  trial_ends_at timestamptz,
  paypal_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  member_twitch_id text not null references public.twitch_users(twitch_id) on delete cascade,
  role public.project_role not null,
  active boolean not null default true,
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, member_twitch_id)
);

create unique index project_members_one_owner_per_project
  on public.project_members(project_id)
  where role = 'owner' and active;

create index project_members_active_member_idx
  on public.project_members(member_twitch_id, project_id)
  where active;

create table public.project_invites (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  token_hash char(64) not null unique,
  created_by_twitch_id text not null references public.twitch_users(twitch_id) on delete restrict,
  expires_at timestamptz not null,
  accepted_by_twitch_id text references public.twitch_users(twitch_id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index project_invites_active_idx
  on public.project_invites(project_id, expires_at)
  where accepted_at is null and revoked_at is null;

create table public.project_scenes (
  project_id uuid primary key references public.projects(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  updated_by_twitch_id text references public.twitch_users(twitch_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(state) = 'object')
);

create table public.project_viewer_sessions (
  project_id uuid primary key references public.projects(id) on delete cascade,
  session_id uuid not null,
  connected_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_twitch_id text references public.twitch_users(twitch_id) on delete set null,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(metadata) = 'object')
);

create index audit_events_project_created_idx
  on public.audit_events(project_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger twitch_users_set_updated_at
before update on public.twitch_users
for each row execute function public.set_updated_at();

create trigger projects_set_updated_at
before update on public.projects
for each row execute function public.set_updated_at();

create trigger project_scenes_set_updated_at
before update on public.project_scenes
for each row execute function public.set_updated_at();

create or replace function public.enforce_editor_limit()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  active_editors integer;
begin
  if new.role = 'editor' and new.active then
    select count(*) into active_editors
    from public.project_members
    where project_id = new.project_id
      and role = 'editor'
      and active
      and id is distinct from new.id;

    if active_editors >= 2 then
      raise exception 'Este proyecto ya tiene el máximo de dos invitados activos.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger project_members_enforce_editor_limit
before insert or update of project_id, role, active on public.project_members
for each row execute function public.enforce_editor_limit();

-- Defensa en profundidad: no se expone ninguna tabla de Tango GG a claves de navegador.
revoke all on table
  public.twitch_users,
  public.projects,
  public.project_members,
  public.project_invites,
  public.project_scenes,
  public.project_viewer_sessions,
  public.audit_events
from anon, authenticated;

revoke all on sequence public.audit_events_id_seq from anon, authenticated;
revoke usage on type public.project_role from anon, authenticated;
revoke usage on type public.subscription_status from anon, authenticated;

alter table public.twitch_users enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.project_invites enable row level security;
alter table public.project_scenes enable row level security;
alter table public.project_viewer_sessions enable row level security;
alter table public.audit_events enable row level security;
