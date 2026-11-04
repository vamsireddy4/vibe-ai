alter table public.whatsapp_templates
  add column if not exists header_enabled boolean not null default false,
  add column if not exists header_type text,
  add column if not exists header_text text not null default '',
  add column if not exists footer_enabled boolean not null default false,
  add column if not exists buttons_enabled boolean not null default false,
  add column if not exists buttons jsonb not null default '[]'::jsonb,
  add column if not exists parameter_tokens text[] not null default array[]::text[],
  add column if not exists carousel_cards jsonb not null default '[]'::jsonb,
  add column if not exists meta_template_id text,
  add column if not exists meta_status text not null default 'draft';

alter table public.whatsapp_templates
  drop constraint if exists whatsapp_templates_header_type_check;

alter table public.whatsapp_templates
  add constraint whatsapp_templates_header_type_check
  check (header_type is null or header_type in ('text', 'image', 'video', 'document'));

alter table public.whatsapp_templates
  drop constraint if exists whatsapp_templates_meta_status_check;

alter table public.whatsapp_templates
  add constraint whatsapp_templates_meta_status_check
  check (meta_status in ('draft', 'pending_review', 'approved', 'rejected', 'paused'));

create unique index if not exists whatsapp_templates_user_normalized_language_idx
  on public.whatsapp_templates(user_id, normalized_name, language);

update public.whatsapp_templates
set
  footer_enabled = coalesce(length(nullif(trim(footer_text), '')) > 0, false),
  buttons_enabled = coalesce(array_length(button_types, 1), 0) > 0,
  buttons = case
    when coalesce(array_length(button_types, 1), 0) = 0 then '[]'::jsonb
    else (
      select jsonb_agg(
        jsonb_build_object(
          'type', button_type,
          'label',
          case button_type
            when 'visit_website' then 'Visit Website'
            when 'call_phone' then 'Call Phone'
            when 'quick_message' then 'Quick Message'
            else initcap(replace(button_type, '_', ' '))
          end
        )
      )
      from unnest(button_types) as button_type
    )
  end,
  parameter_tokens = coalesce(
    (
      select array_agg(distinct matches[1])
      from regexp_matches(body, '\{\{\s*([^}]+?)\s*\}\}', 'g') as matches
    ),
    array[]::text[]
  )
where true;
