alter table public.whatsapp_campaigns
  add column if not exists started_at timestamp with time zone,
  add column if not exists completed_at timestamp with time zone,
  add column if not exists total_contacts integer not null default 0,
  add column if not exists sent_count integer not null default 0,
  add column if not exists failed_count integer not null default 0,
  add column if not exists outcomes jsonb not null default '[]'::jsonb;

alter table public.audience_campaigns
  add column if not exists started_at timestamp with time zone,
  add column if not exists completed_at timestamp with time zone,
  add column if not exists total_contacts integer not null default 0,
  add column if not exists sent_count integer not null default 0,
  add column if not exists failed_count integer not null default 0,
  add column if not exists outcomes jsonb not null default '[]'::jsonb;
