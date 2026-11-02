-- Исправления результатов и история. Существующая учётная запись admin.
create table if not exists public.tournament_corrections (
  id bigserial primary key,
  tournament_id bigint not null references public.tournaments(id),
  room_id text not null,
  actor_id uuid not null references auth.users(id),
  reason text not null,
  before_state jsonb not null,
  after_state jsonb not null,
  undo_of bigint references public.tournament_corrections(id),
  created_at timestamptz not null default now()
);
alter table public.tournament_corrections enable row level security;
revoke all on public.tournament_corrections from anon, authenticated;
grant select on public.tournament_corrections to authenticated;
drop policy if exists corrections_read on public.tournament_corrections;
create policy corrections_read on public.tournament_corrections for select to authenticated
  using (public.is_admin());

create or replace function public.vp_correct_tournament(
  p_tournament_id bigint, p_expected_state jsonb, p_players jsonb,
  p_snapshot jsonb, p_reason text, p_undo_id bigint default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  t public.tournaments%rowtype;
  old_state jsonb;
  next_state jsonb;
  answer jsonb;
  history public.tournament_corrections%rowtype;
  audit_id bigint;
  n integer;
  busted integer;
begin
  if auth.uid() is null or not coalesce(public.is_admin(),false) then
    raise exception 'Исправления доступны администратору клуба';
  end if;
  if length(btrim(coalesce(p_reason,''))) not between 3 and 500 then
    raise exception 'Укажи причину исправления (от 3 до 500 символов)';
  end if;
  select * into t from tournaments where id=p_tournament_id for update;
  if not found or t.room_id is null or t.status='cancelled' then
    raise exception 'У турнира нет доступной комнаты или он отменён';
  end if;
  select state into old_state from rooms where room_id=t.room_id for update;
  if not found then raise exception 'Комната турнира удалена. Исправление недоступно'; end if;
  -- Таймер продолжает идти: конфликт проверяется по данным, которые меняет редактор.
  if old_state->'players' is distinct from p_expected_state->'players'
     or old_state->'tournament' is distinct from p_expected_state->'tournament'
     or old_state->'rating' is distinct from p_expected_state->'rating' then
    raise exception 'Данные турнира изменились. Нажми «Обновить» и проверь правку заново';
  end if;
  if p_undo_id is not null then
    select * into history from tournament_corrections where tournament_id=t.id order by id desc limit 1;
    if not found or history.id<>p_undo_id or history.undo_of is not null
       or history.after_state->'players' is distinct from old_state->'players'
       or history.after_state->'rating' is distinct from old_state->'rating'
       or history.after_state->'tournament' is distinct from old_state->'tournament' then
      raise exception 'Отмена недоступна: после исправления данные уже изменились';
    end if;
    if p_players is distinct from history.before_state->'players' then
      raise exception 'Данные отмены не совпадают с историей';
    end if;
  end if;
  if jsonb_typeof(p_players) is distinct from 'array' or jsonb_array_length(p_players)=0 then
    raise exception 'Список игроков пуст';
  end if;
  if p_players=old_state->'players' then raise exception 'Изменений нет'; end if;
  if exists(select 1 from jsonb_array_elements(p_players) p where nullif(btrim(p->>'name'),'') is null)
     or exists(select 1 from jsonb_array_elements(p_players) p where p->>'player_id' is not null group by p->>'player_id' having count(*)>1) then
    raise exception 'Проверь имена игроков: пустые имена и повторяющиеся игроки недопустимы';
  end if;
  select count(*) filter(where (p->>'present')::boolean),
    count(*) filter(where (p->>'present')::boolean and p->>'status'='busted')
    into n,busted from jsonb_array_elements(p_players) p;
  next_state:=jsonb_set(old_state,'{players}',p_players);
  next_state:=jsonb_set(next_state,'{stats}',jsonb_build_object('registered',n,'busted',busted,'alive',n-busted,
    'reentries',(select coalesce(sum((p->>'reentries')::int),0) from jsonb_array_elements(p_players) p)));
  next_state:=jsonb_set(next_state,'{_savedAt}',to_jsonb(greatest(
    floor(extract(epoch from clock_timestamp())*1000)::bigint,
    coalesce(ceil((old_state->>'_savedAt')::numeric)::bigint,0)+1)));
  update rooms set state=next_state where room_id=t.room_id;
  if old_state#>>'{tournament,finishedAt}' is not null or t.status='past' then
    -- Та же атомарная запись итогов, что при обычном завершении.
    answer:=public.vp_finish_tournament(t.room_id,t.id,next_state,p_snapshot);
    next_state:=answer->'state';
  end if;
  insert into tournament_corrections(tournament_id,room_id,actor_id,reason,before_state,after_state,undo_of)
    values(t.id,t.room_id,auth.uid(),btrim(p_reason),old_state,next_state,p_undo_id) returning id into audit_id;
  return jsonb_build_object('state',next_state,'correction_id',audit_id);
end $$;
revoke all on function public.vp_correct_tournament(bigint,jsonb,jsonb,jsonb,text,bigint) from public;
grant execute on function public.vp_correct_tournament(bigint,jsonb,jsonb,jsonb,text,bigint) to authenticated;
notify pgrst, 'reload schema';
