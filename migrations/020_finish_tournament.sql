-- Завершённый вечер не должен запуститься от запоздалой записи другого таймера.
create or replace function public.vp_keep_finished_timer_stopped()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.state#>>'{tournament,finishedAt}' is not null
     and old.state#>>'{tournament,createdAt}' = new.state#>>'{tournament,createdAt}' then
    new.state := jsonb_set(new.state, '{tournament,finishedAt}', old.state#>'{tournament,finishedAt}');
  end if;
  if new.state#>>'{tournament,finishedAt}' is not null then
    new.state := jsonb_set(new.state, '{timer}', coalesce(new.state->'timer', '{}'::jsonb) ||
      '{"isRunning":false,"isPaused":false,"levelEndAt":null,"pauseRemainingSec":null,"breakUntil":null,"savedRemainingSec":null,"finalTableActive":false}'::jsonb);
  end if;
  return new;
end;
$$;
drop trigger if exists vp_finished_timer on public.rooms;
create trigger vp_finished_timer before update of state on public.rooms
for each row execute function public.vp_keep_finished_timer_stopped();

-- Завершение вечера атомарно: оплаты, места, таймер и публикация.
create or replace function public.vp_finish_tournament(
  p_room_id text, p_tournament_id bigint, p_expected_state jsonb, p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state jsonb;
  v_tournament public.tournaments%rowtype;
  v_result_id bigint;
  v_key text;
  v_count integer;
  v_rows jsonb := p_snapshot->'players';
  v_finished text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if auth.uid() is null or not public.can_access_room(p_room_id) then
    raise exception 'Нет доступа к завершению турнира';
  end if;
  select * into v_tournament from public.tournaments where id = p_tournament_id for update;
  if not found or v_tournament.room_id is distinct from p_room_id then
    raise exception 'Привязка турнира изменилась. Обнови страницу';
  end if;
  if v_tournament.status = 'cancelled' then
    raise exception 'Отменённый турнир нельзя завершить';
  end if;
  select state into v_state from public.rooms where room_id = p_room_id for update;
  if not found then raise exception 'Комната не найдена'; end if;
  if v_state is distinct from p_expected_state then
    raise exception 'Данные турнира изменились. Проверь оплаты и места заново';
  end if;
  if jsonb_typeof(v_rows) is distinct from 'array' then
    raise exception 'Нет результатов игроков';
  end if;
  v_count := jsonb_array_length(v_rows);
  if v_count < 2 or exists (
    select 1 from jsonb_to_recordset(v_rows) as p(place integer)
    where p.place is null or p.place < 1 or p.place > v_count
  ) or (select count(distinct p.place) from jsonb_to_recordset(v_rows) as p(place integer)) <> v_count then
    raise exception 'Укажи итоговые места всех игроков без пропусков и повторов';
  end if;
  -- Снимок обязан содержать ровно пришедших игроков свежей комнаты.
  if exists (
    (select btrim(regexp_replace(p->>'name', '\s+', ' ', 'g')) from jsonb_array_elements(v_state->'players') p
      where (p->>'present')::boolean
     except all select p.name from jsonb_to_recordset(v_rows) as p(name text))
    union all
    (select p.name from jsonb_to_recordset(v_rows) as p(name text)
     except all select btrim(regexp_replace(p->>'name', '\s+', ' ', 'g')) from jsonb_array_elements(v_state->'players') p
      where (p->>'present')::boolean)
  ) then raise exception 'Состав отчёта не совпадает с игроками комнаты'; end if;
  if nullif(v_state#>>'{tournament,createdAt}', '') is null then
    raise exception 'В комнате не указана дата создания турнира';
  end if;
  v_key := p_room_id || '__' || (v_state#>>'{tournament,createdAt}');
  insert into public.tournament_results (
    report_key, room_id, tournament_id, name, played_at, buy_in, players_count,
    entries, reentries, expected, paid, debt, transfer, cash, card, created_by
  ) select v_key, p_room_id, p_tournament_id,
    coalesce(nullif(v_state#>>'{tournament,name}', ''), v_tournament.name),
    (v_state#>>'{tournament,createdAt}')::timestamptz,
    coalesce((v_state#>>'{tournament,defaultBuyIn}')::integer, 0), v_count,
    sum(p.entries), sum(p.reentries), sum(p.expected), sum(p.paid), sum(p.debt),
    sum(p.transfer), sum(p.cash), sum(p.card), auth.uid()
  from jsonb_to_recordset(v_rows) as p(entries integer, reentries integer, expected integer,
    paid integer, debt integer, transfer integer, cash integer, card integer)
  on conflict (report_key) do update set
    tournament_id = excluded.tournament_id, name = excluded.name, played_at = excluded.played_at,
    buy_in = excluded.buy_in, players_count = excluded.players_count, entries = excluded.entries,
    reentries = excluded.reentries, expected = excluded.expected, paid = excluded.paid,
    debt = excluded.debt, transfer = excluded.transfer, cash = excluded.cash, card = excluded.card
  returning id into v_result_id;

  delete from public.tournament_result_players where result_id = v_result_id;
  insert into public.tournament_result_players (
    result_id, player_id, name, place, entries, reentries, ko, points,
    buy_in, expected, paid, debt, transfer, cash, card
  ) select v_result_id, p.player_id, p.name, p.place, p.entries, p.reentries, p.ko, p.points,
    p.buy_in, p.expected, p.paid, p.debt, p.transfer, p.cash, p.card
  from jsonb_to_recordset(v_rows) as p(player_id bigint, name text, place integer,
    entries integer, reentries integer, ko integer, points integer, buy_in integer,
    expected integer, paid integer, debt integer, transfer integer, cash integer, card integer);

  v_state := jsonb_set(v_state, '{timer}', coalesce(v_state->'timer', '{}'::jsonb) ||
    '{"isRunning":false,"isPaused":false,"levelEndAt":null,"pauseRemainingSec":null,"breakUntil":null,"savedRemainingSec":null,"finalTableActive":false}'::jsonb);
  v_state := jsonb_set(v_state, '{tournament,finishedAt}',
    to_jsonb(coalesce(v_state#>>'{tournament,finishedAt}', v_finished)));
  v_state := jsonb_set(v_state, '{_savedAt}', to_jsonb(greatest(
    floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
    coalesce((v_state->>'_savedAt')::bigint, 0) + 1)));
  update public.rooms set state = v_state where room_id = p_room_id;
  update public.tournaments set status = 'past' where id = p_tournament_id;
  return jsonb_build_object('result_id', v_result_id, 'state', v_state);
end;
$$;
revoke all on function public.vp_finish_tournament(text, bigint, jsonb, jsonb) from public, anon;
grant execute on function public.vp_finish_tournament(text, bigint, jsonb, jsonb) to authenticated;
notify pgrst, 'reload schema';
