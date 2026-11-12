-- v10: aprovação de temas semanais (Léo propõe, cliente aprova / recusa / sugere)
create table if not exists public.theme_weeks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  theme text not null default '',
  sent_at timestamptz,
  created_at timestamptz default now()
);
create table if not exists public.theme_items (
  id uuid primary key default gen_random_uuid(),
  week_id uuid not null references public.theme_weeks(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  post_date date,
  channel text not null default 'instagram',
  type text not null default 'post',
  title text not null default '',
  status text not null default 'rascunho',   -- rascunho | aguardando | aprovado | recusado
  suggestion text,
  decided_at timestamptz,
  in_calendar boolean not null default false,
  sort_order integer default 0,
  created_at timestamptz default now()
);
create index if not exists theme_weeks_client_idx on public.theme_weeks(client_id, week_start);
create index if not exists theme_items_week_idx on public.theme_items(week_id, sort_order);
alter table public.theme_weeks enable row level security;
alter table public.theme_items enable row level security;

drop policy if exists "admin temas semanas" on public.theme_weeks;
create policy "admin temas semanas" on public.theme_weeks for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists "cliente le semanas enviadas" on public.theme_weeks;
create policy "cliente le semanas enviadas" on public.theme_weeks for select
  using (sent_at is not null and client_id = (select p.client_id from public.profiles p where p.id = auth.uid()));

drop policy if exists "admin temas itens" on public.theme_items;
create policy "admin temas itens" on public.theme_items for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists "cliente le itens enviados" on public.theme_items;
create policy "cliente le itens enviados" on public.theme_items for select
  using (status <> 'rascunho' and client_id = (select p.client_id from public.profiles p where p.id = auth.uid()));
drop policy if exists "cliente decide itens" on public.theme_items;
create policy "cliente decide itens" on public.theme_items for update
  using (status <> 'rascunho' and client_id = (select p.client_id from public.profiles p where p.id = auth.uid()))
  with check (status in ('aprovado','recusado','aguardando') and client_id = (select p.client_id from public.profiles p where p.id = auth.uid()));

notify pgrst, 'reload schema';
