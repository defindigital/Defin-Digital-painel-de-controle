-- ============================================================
-- Defin Digital — Painel de Controle
-- Migração v7: sincronização automática de posts / reels / stories
-- Seguro rodar mais de uma vez.
-- ============================================================

-- Cada publicação (post, reel ou story) vista na Meta, com a data em que saiu.
-- Os stories somem do perfil em 24h; por isso ficam guardados aqui.
create table if not exists published_media (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  platform text not null,                 -- 'instagram' | 'facebook'
  media_id text not null,
  kind text not null,                     -- 'post' | 'reel' | 'story'
  published_at timestamptz not null,
  permalink text,
  created_at timestamptz default now(),
  unique (client_id, platform, media_id)
);
create index if not exists published_media_client_date on published_media (client_id, platform, published_at);
alter table published_media enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename='published_media' and policyname='Admin full access published_media') then
    create policy "Admin full access published_media" on published_media
      for all using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
      with check (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
  end if;
end $$;

-- Campos que o admin editou na mão (a sincronização não sobrescreve esses)
alter table deliverable_months add column if not exists deliverables_manual jsonb default '{}'::jsonb;
alter table deliverable_months add column if not exists deliverables_synced_at timestamptz;

notify pgrst, 'reload schema';
