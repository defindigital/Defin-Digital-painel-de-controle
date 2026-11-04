-- v8: Meta Ads em tempo real
alter table public.clients add column if not exists ad_account_id text;
alter table public.meta_ads_data add column if not exists last_synced_at timestamptz;
alter table public.meta_ads_data add column if not exists synced_auto boolean default false;
notify pgrst, 'reload schema';
