create table public.twitch_bot_channel_authorizations (
  broadcaster_id text primary key,
  login text not null,
  display_name text not null,
  profile_image_url text,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  authorized_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.twitch_bot_channel_authorizations enable row level security;

revoke all on table public.twitch_bot_channel_authorizations from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.twitch_bot_channel_authorizations to service_role;

create trigger twitch_bot_channel_authorizations_set_updated_at
before update on public.twitch_bot_channel_authorizations
for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
