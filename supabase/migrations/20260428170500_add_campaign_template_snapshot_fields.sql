alter table public.whatsapp_campaigns
  add column if not exists template_name text,
  add column if not exists template_language text,
  add column if not exists template_structure jsonb not null default '{}'::jsonb,
  add column if not exists delivered integer not null default 0,
  add column if not exists failed integer not null default 0,
  add column if not exists sent_date timestamp with time zone;

alter table public.audience_campaigns
  add column if not exists template_name text,
  add column if not exists template_language text,
  add column if not exists template_structure jsonb not null default '{}'::jsonb,
  add column if not exists delivered integer not null default 0,
  add column if not exists failed integer not null default 0,
  add column if not exists sent_date timestamp with time zone;
