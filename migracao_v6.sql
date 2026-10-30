-- ============================================================
-- Defin Digital — Painel de Controle
-- Migração v6: canais de redes sociais por cliente + ciclos de 30 dias
-- Seguro rodar mais de uma vez.
-- ============================================================

-- Canais contratados dentro de "Redes sociais". NULL = cliente antigo (mantém os 3).
alter table clients add column if not exists social_channels text[];

-- Data de início do cliente. Com ela, cada mês tem 30 dias contados a partir
-- da data. NULL = cliente antigo, continua no ciclo do dia fixo (ex: Mauro, dia 23).
alter table clients add column if not exists cycle_start_date date;
