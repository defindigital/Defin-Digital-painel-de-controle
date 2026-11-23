-- v13: Google Meu Negócio completo (buscas, agendamentos, plataformas, termos, avaliações)
alter table public.gmn_data add column if not exists ligacoes integer;
alter table public.gmn_data add column if not exists buscas integer;
alter table public.gmn_data add column if not exists agendamentos integer;
alter table public.gmn_data add column if not exists avaliacao_nota numeric(2,1);
alter table public.gmn_data add column if not exists avaliacoes_total integer;
alter table public.gmn_data add column if not exists plataformas jsonb;
alter table public.gmn_data add column if not exists termos jsonb;
alter table public.gmn_data add column if not exists termos_periodo text;

-- JF Manutenções e Acabamentos — novembro/2026 (parcial, lido do Perfil da Empresa em 23/11)
insert into public.gmn_data (client_id, deliverable_month_id, visualizacoes, cliques_site, solicitacoes_rota, ligacoes, agendamentos, avaliacao_nota, avaliacoes_total, plataformas, termos, termos_periodo, note)
values ('56632e4b-2e93-423c-9f35-26d83fe49691','98654aba-c63c-46a1-a54e-e54100182021',750,7,26,14,0,4.7,65,
 '[{"k":"Pesquisa Google – celular","v":544},{"k":"Pesquisa Google – computador","v":104},{"k":"Google Maps – celular","v":66},{"k":"Google Maps – computador","v":36}]'::jsonb,
 '[{"k":"marido de aluguel maringa","v":233},{"k":"encanador maringa","v":143},{"k":"marido de aluguel","v":102},{"k":"indio","v":96},{"k":"marido de aluguel em maringa","v":66}]'::jsonb,
 'Acumulado jun–nov/2026 (o Google ainda está coletando os termos de novembro)',
 'Novembro parcial, dados lidos em 23/11. Acumulado jun–nov/2026: 4.559 visualizações, 694 buscas, 73 ligações, 258 rotas e 32 cliques no site.')
on conflict (deliverable_month_id) do update set visualizacoes=excluded.visualizacoes, cliques_site=excluded.cliques_site, solicitacoes_rota=excluded.solicitacoes_rota, ligacoes=excluded.ligacoes, agendamentos=excluded.agendamentos, avaliacao_nota=excluded.avaliacao_nota, avaliacoes_total=excluded.avaliacoes_total, plataformas=excluded.plataformas, termos=excluded.termos, termos_periodo=excluded.termos_periodo, note=excluded.note;
notify pgrst, 'reload schema';
