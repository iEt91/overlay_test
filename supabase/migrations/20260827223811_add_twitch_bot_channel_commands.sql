create table public.twitch_bot_channel_state (
  broadcaster_id text primary key references public.twitch_bot_channel_authorizations(broadcaster_id) on delete cascade,
  delay_seconds integer not null default 0 check (delay_seconds in (0, 10, 25, 30, 45, 60, 70)),
  updated_at timestamptz not null default now()
);

create table public.twitch_bot_commands (
  broadcaster_id text not null references public.twitch_bot_channel_authorizations(broadcaster_id) on delete cascade,
  command_name text not null check (command_name ~ '^![a-z0-9_]{1,30}$'),
  response_type text not null check (response_type in ('delay', 'static')),
  response_text text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (broadcaster_id, command_name),
  check (
    (response_type = 'delay' and response_text is null)
    or (response_type = 'static' and char_length(btrim(response_text)) between 1 and 500)
  )
);

insert into public.twitch_bot_channel_state (broadcaster_id)
select broadcaster_id from public.twitch_bot_channel_authorizations
on conflict (broadcaster_id) do nothing;

insert into public.twitch_bot_commands (broadcaster_id, command_name, response_type)
select broadcaster_id, '!delay', 'delay' from public.twitch_bot_channel_authorizations
on conflict (broadcaster_id, command_name) do nothing;

alter table public.twitch_bot_channel_state enable row level security;
alter table public.twitch_bot_commands enable row level security;

revoke all on table public.twitch_bot_channel_state from anon, authenticated;
revoke all on table public.twitch_bot_commands from anon, authenticated;
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.twitch_bot_channel_state to service_role;
grant select, insert, update, delete on table public.twitch_bot_commands to service_role;

create trigger twitch_bot_channel_state_set_updated_at
before update on public.twitch_bot_channel_state
for each row execute function public.set_updated_at();

create trigger twitch_bot_commands_set_updated_at
before update on public.twitch_bot_commands
for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
