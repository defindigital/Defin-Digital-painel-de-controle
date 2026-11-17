-- v12: cliques do link rastreável (Cloudflare Worker) dentro do painel de cada cliente
alter table public.clients add column if not exists link_slug text;
create table if not exists public.link_clicks (
  id bigserial primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  clicked_at timestamptz not null default now(),
  link text not null,
  origem text, cidade text, estado text, pais text, aparelho text
);
create index if not exists link_clicks_client_idx on public.link_clicks(client_id, clicked_at desc);
alter table public.link_clicks enable row level security;
drop policy if exists "admin le cliques" on public.link_clicks;
create policy "admin le cliques" on public.link_clicks for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists "cliente le seus cliques" on public.link_clicks;
create policy "cliente le seus cliques" on public.link_clicks for select
  using (client_id = (select p.client_id from public.profiles p where p.id = auth.uid()));

-- o Worker registra o clique por esta função (sem login); ela só aceita clientes com link_slug cadastrado
create or replace function public.log_link_click(p_slug text, p_link text, p_ts timestamptz default now(), p_origem text default null, p_cidade text default null, p_estado text default null, p_pais text default null, p_aparelho text default null)
returns void language plpgsql security definer set search_path = public as $$
declare cid uuid;
begin
  select id into cid from clients where link_slug = lower(btrim(p_slug)) limit 1;
  if cid is null then return; end if;
  insert into link_clicks (client_id, clicked_at, link, origem, cidade, estado, pais, aparelho)
  values (cid, least(coalesce(p_ts, now()), now()), left(coalesce(p_link,'?'), 40), left(p_origem, 60), left(p_cidade, 80), left(p_estado, 60), left(p_pais, 10), left(p_aparelho, 40));
end $$;
revoke all on function public.log_link_click(text,text,timestamptz,text,text,text,text,text) from public;
grant execute on function public.log_link_click(text,text,timestamptz,text,text,text,text,text) to anon, authenticated;

update public.clients set link_slug = 'jf' where name ilike 'JF %' and link_slug is null;
notify pgrst, 'reload schema';
