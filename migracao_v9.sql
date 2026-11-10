-- v9: períodos (semanais) de Meta Ads, com travamento e comparativo
create table if not exists public.meta_ads_periods (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  label text,
  start_date date not null,
  end_date date not null,
  investimento numeric default 0,
  alcance integer default 0,
  cliques integer default 0,
  leads integer default 0,
  note text,
  locked boolean not null default false,
  synced_auto boolean default false,
  last_synced_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists meta_ads_periods_client_idx on public.meta_ads_periods(client_id, start_date);
alter table public.meta_ads_periods enable row level security;

drop policy if exists "admin gerencia periodos ads" on public.meta_ads_periods;
create policy "admin gerencia periodos ads" on public.meta_ads_periods
  for all using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

drop policy if exists "cliente le seus periodos ads" on public.meta_ads_periods;
create policy "cliente le seus periodos ads" on public.meta_ads_periods
  for select using (client_id = (select p.client_id from public.profiles p where p.id = auth.uid()));

-- JF Reparos e Acabamentos: semana 03–07/11 e semana 09–14/11
insert into public.meta_ads_periods (client_id, label, start_date, end_date)
select c.id, v.label, v.s::date, v.e::date
from public.clients c,
     (values ('Semana 1','2026-11-03','2026-11-07'), ('Semana 2','2026-11-09','2026-11-14')) as v(label,s,e)
where c.name ilike 'JF Reparos%'
  and not exists (select 1 from public.meta_ads_periods x where x.client_id = c.id and x.start_date = v.s::date);

-- Mauro Alvisi: libera a aba Meta Ads
update public.clients
set services = case when services @> '["meta_ads"]'::jsonb then services else services || '["meta_ads"]'::jsonb end
where name ilike 'Mauro Alvisi%';

notify pgrst, 'reload schema';
