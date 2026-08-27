-- Credenciales del bot global de Tango GG. Sólo server.js las usa mediante
-- SUPABASE_SECRET_KEY; las claves OAuth cifradas nunca se exponen al navegador.
create table public.twitch_bot_installations (
  singleton boolean primary key default true check (singleton),
  twitch_id text not null,
  login text not null,
  display_name text not null,
  profile_image_url text,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.twitch_bot_installations enable row level security;
revoke all on table public.twitch_bot_installations from anon, authenticated;

create trigger twitch_bot_installations_set_updated_at
before update on public.twitch_bot_installations
for each row execute function public.set_updated_at();
