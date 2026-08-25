-- Marca de prueba mostrada únicamente en el Viewer de proyectos trialing.
-- La controla Tango GG desde la base: el streamer no puede desactivarla.
alter table public.projects
  add column if not exists trial_watermark_enabled boolean not null default true;

comment on column public.projects.trial_watermark_enabled is
  'Control administrativo de la marca de agua del trial. false la oculta para ese proyecto.';
