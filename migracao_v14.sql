-- v14: Google Meu Negócio mês a mês + visão geral (por cliente), lido do Desempenho do Perfil da Empresa
create table if not exists public.gmn_monthly (
  id bigserial primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  ym text not null,                 -- 'YYYY-MM' ou 'geral' (acumulado do período lido)
  periodo text,                     -- rótulo do acumulado, ex. 'jun–nov/2026'
  parcial boolean not null default false,
  visualizacoes integer, buscas integer, ligacoes integer, rotas integer, cliques_site integer, agendamentos integer,
  avaliacao_nota numeric(2,1), avaliacoes_total integer,
  plataformas jsonb, termos jsonb, termos_nota text,
  lido_em timestamptz not null default now(),
  unique (client_id, ym)
);
alter table public.gmn_monthly enable row level security;
drop policy if exists "admin le gmn" on public.gmn_monthly;
create policy "admin le gmn" on public.gmn_monthly for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));
drop policy if exists "cliente le seu gmn" on public.gmn_monthly;
create policy "cliente le seu gmn" on public.gmn_monthly for select
  using (client_id = (select p.client_id from public.profiles p where p.id = auth.uid()));

with c as (select '56632e4b-2e93-423c-9f35-26d83fe49691'::uuid id)
insert into public.gmn_monthly (client_id, ym, periodo, parcial, visualizacoes, buscas, ligacoes, rotas, cliques_site, agendamentos, avaliacao_nota, avaliacoes_total, plataformas, termos, termos_nota) values
((select id from c),'geral','jun–nov/2026',false,4559,694,73,258,32,0,4.7,65,
 '[{"k":"Pesquisa Google – celular","v":2935},{"k":"Pesquisa Google – computador","v":710},{"k":"Google Maps – celular","v":553},{"k":"Google Maps – computador","v":361}]',
 '[{"k":"marido de aluguel maringa","v":233},{"k":"encanador maringa","v":143},{"k":"marido de aluguel","v":102},{"k":"indio","v":96},{"k":"marido de aluguel em maringa","v":66}]', null),
((select id from c),'2026-06',null,false,678,112,19,24,5,0,null,null,
 '[{"k":"Pesquisa Google – celular","v":415},{"k":"Pesquisa Google – computador","v":127},{"k":"Google Maps – celular","v":91},{"k":"Google Maps – computador","v":45}]',
 '[{"k":"marido de aluguel maringa","v":31},{"k":"encanador maringa","v":24},{"k":"marido","v":21},{"k":"marido de aluguel em maringa","v":20},{"k":"marido de aluguel","v":16}]', null),
((select id from c),'2026-07',null,false,702,95,12,38,3,0,null,null,
 '[{"k":"Pesquisa Google – celular","v":415},{"k":"Pesquisa Google – computador","v":137},{"k":"Google Maps – celular","v":88},{"k":"Google Maps – computador","v":62}]',
 '[{"k":"marido de aluguel maringa","v":38},{"k":"encanador maringa","v":31},{"k":"marido de aluguel em maringa","v":26}]', 'Demais termos com menos de 15 buscas'),
((select id from c),'2026-08',null,false,730,129,8,53,7,0,null,null,
 '[{"k":"Pesquisa Google – celular","v":451},{"k":"Pesquisa Google – computador","v":91},{"k":"Google Maps – celular","v":111},{"k":"Google Maps – computador","v":77}]',
 '[{"k":"indio","v":36},{"k":"marido de aluguel maringa","v":33},{"k":"marido de aluguel","v":23},{"k":"encanador maringa","v":21},{"k":"índio maringá","v":16}]', null),
((select id from c),'2026-09',null,false,725,154,0,77,6,0,null,null,
 '[{"k":"Pesquisa Google – celular","v":465},{"k":"Pesquisa Google – computador","v":112},{"k":"Google Maps – celular","v":79},{"k":"Google Maps – computador","v":69}]',
 '[{"k":"marido de aluguel maringa","v":49},{"k":"indio","v":33},{"k":"encanador maringa","v":31},{"k":"marido de aluguel","v":24},{"k":"marido de aluguel em maringá","v":17}]', null),
((select id from c),'2026-10',null,false,974,204,20,40,4,0,null,null,
 '[{"k":"Pesquisa Google – celular","v":645},{"k":"Pesquisa Google – computador","v":139},{"k":"Google Maps – celular","v":118},{"k":"Google Maps – computador","v":72}]',
 '[{"k":"marido de aluguel maringa","v":82},{"k":"marido de aluguel","v":39},{"k":"encanador maringa","v":36},{"k":"indio","v":27},{"k":"marido de aluguel em maringa","v":20}]', null),
((select id from c),'2026-11',null,true,750,null,14,26,7,0,null,null,
 '[{"k":"Pesquisa Google – celular","v":544},{"k":"Pesquisa Google – computador","v":104},{"k":"Google Maps – celular","v":66},{"k":"Google Maps – computador","v":36}]',
 null, 'O Google ainda está coletando buscas e termos de novembro')
on conflict (client_id, ym) do update set periodo=excluded.periodo, parcial=excluded.parcial, visualizacoes=excluded.visualizacoes, buscas=excluded.buscas, ligacoes=excluded.ligacoes, rotas=excluded.rotas, cliques_site=excluded.cliques_site, agendamentos=excluded.agendamentos, avaliacao_nota=excluded.avaliacao_nota, avaliacoes_total=excluded.avaliacoes_total, plataformas=excluded.plataformas, termos=excluded.termos, termos_nota=excluded.termos_nota, lido_em=now();
notify pgrst, 'reload schema';
