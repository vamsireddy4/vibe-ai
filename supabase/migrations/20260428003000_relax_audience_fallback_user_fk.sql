alter table if exists public.audience_segments
  drop constraint if exists audience_segments_user_id_fkey;

alter table if exists public.audience_segment_contacts
  drop constraint if exists audience_segment_contacts_user_id_fkey;

alter table if exists public.audience_campaigns
  drop constraint if exists audience_campaigns_user_id_fkey;
