-- ═══════════════════════════════════════════════════════════════════════════
-- Название сыгранного турнира — из расписания, а не из комнаты таймера.
--
-- Снимок вечера (tournament_results.name) брал имя из состояния комнаты
-- (state.tournament.name) — и vp_finish_tournament, и saveReportSnapshot в
-- admin.html. Комнату админ называет как попало («Среда», «test»), и в
-- истории игрока, в публичном профиле и в CRM висело это имя, а не то, что
-- стоит в tournaments.html.
--
-- Правим одним триггером, а не в двух местах записи: если у снимка есть
-- привязка к турниру, имя всегда берётся оттуда. Переименование турнира в
-- расписании доезжает до уже сыгранных снимков. Снимки без привязки (турнир
-- удалили или комнату не связали) сохраняют имя комнаты — другого нет.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._result_name_from_tournament()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if new.tournament_id is not null then
    select nullif(btrim(t.name), '') into v_name from public.tournaments t where t.id = new.tournament_id;
    if v_name is not null then
      new.name := v_name;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_result_name_from_tournament on public.tournament_results;
create trigger trg_result_name_from_tournament
  before insert or update of name, tournament_id on public.tournament_results
  for each row execute function public._result_name_from_tournament();

create or replace function public._tournament_name_to_results()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tournament_results
     set name = new.name
   where tournament_id = new.id
     and name is distinct from new.name
     and nullif(btrim(new.name), '') is not null;
  return null;
end;
$$;

drop trigger if exists trg_tournament_name_to_results on public.tournaments;
create trigger trg_tournament_name_to_results
  after update of name on public.tournaments
  for each row when (old.name is distinct from new.name)
  execute function public._tournament_name_to_results();

-- Уже сыгранные.
update public.tournament_results tr
   set name = t.name
  from public.tournaments t
 where tr.tournament_id = t.id
   and tr.name is distinct from t.name
   and nullif(btrim(t.name), '') is not null;
