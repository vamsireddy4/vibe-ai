alter table public.phone_configs
  add column if not exists telnyx_messaging_profile_id text,
  add column if not exists sms_sender_type text,
  add column if not exists telnyx_alpha_sender_id text,
  add column if not exists telnyx_dlt_entity_id text,
  add column if not exists telnyx_dlt_template_id text;

update public.phone_configs
set sms_sender_type = coalesce(nullif(sms_sender_type, ''), case when channel = 'sms' then 'phone_number' else null end)
where channel = 'sms';

alter table public.phone_configs
  drop constraint if exists phone_configs_sms_sender_type_check;

alter table public.phone_configs
  add constraint phone_configs_sms_sender_type_check
  check (sms_sender_type is null or sms_sender_type in ('phone_number', 'alpha_sender'));
