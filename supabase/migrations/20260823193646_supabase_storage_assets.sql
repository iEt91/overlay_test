-- Archivos del overlay fuera del disco efímero del servidor. El bucket es
-- público sólo para descargar/servir los recursos en OBS; no hay políticas de
-- INSERT para clientes, por lo que las subidas siguen pasando exclusivamente
-- por server.js usando la clave secreta que nunca sale del servidor.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'overlay-assets',
  'overlay-assets',
  true,
  26214400,
  array[
    'image/jpeg', 'image/pjpeg', 'image/png', 'image/gif', 'image/webp',
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg',
    'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/x-aac', 'audio/webm'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
