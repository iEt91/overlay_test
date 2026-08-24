-- Segunda capa de acceso para cada sala de Tango GG.
-- La contraseña se calcula y verifica únicamente en server.js; esta columna
-- conserva sólo un hash scrypt con su salt, nunca el valor introducido.
alter table public.projects
  add column if not exists room_password_hash text,
  add column if not exists room_password_updated_at timestamptz;

comment on column public.projects.room_password_hash is
  'Hash scrypt de la contraseña de la sala. Nunca contiene la contraseña en claro.';

comment on column public.projects.room_password_updated_at is
  'Permite invalidar sesiones de sala cuando el streamer modifica la contraseña.';
