-- v11: tema da semana também é aprovável/sugerível pelo cliente + travas após aprovação
alter table public.theme_weeks add column if not exists theme_status text not null default 'aguardando';
alter table public.theme_weeks add column if not exists theme_suggestion text;

-- cliente decide o tema da semana (aprovar ou sugerir outro) sem ter UPDATE direto na tabela
create or replace function public.decide_week_theme(p_week uuid, p_action text, p_text text default null)
returns void language plpgsql security definer set search_path = public as $$
declare w record; me uuid;
begin
  select client_id into me from profiles where id = auth.uid();
  select * into w from theme_weeks where id = p_week;
  if w.id is null or w.sent_at is null or me is null or w.client_id <> me then raise exception 'Semana não encontrada.'; end if;
  if w.theme_status = 'aprovado' then raise exception 'O tema desta semana já foi aprovado.'; end if;
  if p_action = 'approve' then
    update theme_weeks set theme_status = 'aprovado', theme_suggestion = null where id = p_week;
  elsif p_action = 'suggest' then
    if coalesce(btrim(p_text), '') = '' then raise exception 'Escreva o tema que você prefere.'; end if;
    update theme_weeks set theme_status = 'recusado', theme_suggestion = btrim(p_text) where id = p_week;
  else
    raise exception 'Ação inválida.';
  end if;
end $$;
revoke all on function public.decide_week_theme(uuid, text, text) from public, anon;
grant execute on function public.decide_week_theme(uuid, text, text) to authenticated;

-- travas: publicação aprovada não muda mais (só a marca "foi para o Calendário")
create or replace function public.lock_approved_item() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'aprovado' and pg_trigger_depth() = 1 then raise exception 'Publicação aprovada está travada e não pode ser excluída.'; end if;
    return old;
  end if;
  if old.status = 'aprovado' and (new.title, new.post_date, new.type, new.channel, new.status, new.suggestion, new.week_id, new.sort_order)
     is distinct from (old.title, old.post_date, old.type, old.channel, old.status, old.suggestion, old.week_id, old.sort_order) then
    raise exception 'Publicação aprovada está travada e não pode mais ser alterada.';
  end if;
  return new;
end $$;
drop trigger if exists trg_lock_approved_item on public.theme_items;
create trigger trg_lock_approved_item before update or delete on public.theme_items
  for each row execute function public.lock_approved_item();

create or replace function public.lock_approved_week() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() = 1 and (old.theme_status = 'aprovado' or exists (select 1 from theme_items i where i.week_id = old.id and i.status = 'aprovado')) then
      raise exception 'Semana com itens aprovados está travada e não pode ser excluída.';
    end if;
    return old;
  end if;
  if old.theme_status = 'aprovado' and (new.theme, new.theme_status, new.theme_suggestion, new.week_start, new.week_end)
     is distinct from (old.theme, old.theme_status, old.theme_suggestion, old.week_start, old.week_end) then
    raise exception 'O tema aprovado está travado e não pode mais ser alterado.';
  end if;
  return new;
end $$;
drop trigger if exists trg_lock_approved_week on public.theme_weeks;
create trigger trg_lock_approved_week before update or delete on public.theme_weeks
  for each row execute function public.lock_approved_week();

notify pgrst, 'reload schema';
