-- Sesiones de Express persistentes. El navegador mantiene sólo el ID firmado;
-- el contenido de la sesión queda en la base de datos y no contiene tokens Twitch.
create table public.app_sessions (
  sid text primary key,
  session jsonb not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index app_sessions_expires_at_idx on public.app_sessions (expires_at);

alter table public.app_sessions enable row level security;

-- Ningún cliente del navegador puede leer ni escribir sesiones. Sólo el
-- servidor, mediante la clave secreta mantenida en .env, las utiliza.
revoke all on table public.app_sessions from anon, authenticated;
