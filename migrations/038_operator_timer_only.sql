-- Оператор управляет только часами назначенных турниров.
begin;

-- Назначение даёт право на timer RPC, но больше не на CRM/состав/завершение.
create or replace function public.vp_operator_room_access(p_room_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    join public.tournament_operators o on o.profile_id = p.id
    join public.tournaments t on t.id = o.tournament_id
    where p.id = auth.uid() and p.role = 'operator' and t.room_id = p_room_id
  );
$$;

create or replace function public.can_access_room(p_room_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin();
$$;
create or replace function public.can_access_tournament(p_tournament_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin();
$$;

-- Restrictive-политики закрывают все старые permissive-политики этих таблиц.
do $$
declare tbl text;
begin
  foreach tbl in array array['players', 'tournament_results', 'tournament_result_players',
                            'registrations', 'final_declines'] loop
    execute format('drop policy if exists timer_only_admin on public.%I', tbl);
    execute format('create policy timer_only_admin on public.%I as restrictive for all to authenticated using (public.is_admin()) with check (public.is_admin())', tbl);
  end loop;
end;
$$;

-- Полный JSON комнаты содержит деньги. Ни оператору, ни анонимному ТВ его не отдаём.
drop policy if exists rooms_select_all on public.rooms;
create policy rooms_select_all on public.rooms for select to anon, authenticated
  using (public.is_admin());

-- Явные списки полей: новые персональные/денежные поля не станут публичными.
create or replace function public.vp_json_fields(p_data jsonb, p_keys text[])
returns jsonb language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
  from jsonb_each(coalesce(p_data, '{}'::jsonb)) where key = any(p_keys);
$$;

create or replace function public.vp_timer_projection(p_state jsonb, p_display boolean default false)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    '_savedAt', p_state->'_savedAt',
    'tournament', public.vp_json_fields(p_state->'tournament',
      array['name','createdAt','finishedAt','startStack','lateRegUntilLevel','addonEnabled','addon1Stack','addon2Stack','addon3Stack']),
    'timer', public.vp_json_fields(p_state->'timer',
      array['isRunning','isPaused','levelIndex','levelEndAt','pauseRemainingSec','breakUntil','savedRemainingSec','finalTableActive']),
    'structure', jsonb_build_object('levels', coalesce((
      select jsonb_agg(public.vp_json_fields(l, array['min','sb','bb','anteMode','isBreak','label']) order by n)
      from jsonb_array_elements(coalesce(p_state#>'{structure,levels}', '[]')) with ordinality as levels(l,n)
    ), '[]'::jsonb)),
    'stats', public.vp_json_fields(p_state->'stats', array['registered','alive','busted','reentries']),
    'display', public.vp_json_fields(p_state->'display', array['theme']),
    'info', case when p_display then public.vp_json_fields(p_state->'info', array['bonusHand','comment']) else '{}'::jsonb end,
    'rating', case when p_display then public.vp_json_fields(p_state->'rating',
      array['isActive','entries','r','guarantee','P','TOTAL','KO_POOL','ITM_POOL','payouts','calculatedAt','autoShown']) else '{}'::jsonb end,
    -- Только данные, которые уже показываются на ТВ; никаких player_id/оплат.
    'players', case when p_display then coalesce((
      select jsonb_agg(public.vp_json_fields(p, array['name','photo_url','present','status','place','bustOrder','reentries','addon','ko']) order by n)
      from jsonb_array_elements(coalesce(p_state->'players', '[]')) with ordinality as players(p,n)
    ), '[]'::jsonb) else '[]'::jsonb end
  );
$$;

create or replace function public.vp_display_rooms(p_room_ids text[])
returns table(room_id text, state jsonb, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.room_id, public.vp_timer_projection(r.state, true), r.created_at
  from public.rooms r where r.room_id = any(p_room_ids[1:100])
    and r.room_id not like '\_\_%' escape '\';
$$;

create or replace function public.vp_operator_rooms()
returns table(room_id text, state jsonb, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.room_id, public.vp_timer_projection(r.state), r.created_at
  from public.rooms r where public.vp_operator_room_access(r.room_id)
  order by r.created_at desc;
$$;

create or replace function public.vp_operator_timer(p_room_id text, p_timer jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare st jsonb; ti jsonb; k text; v jsonb;
begin
  if not public.vp_operator_room_access(p_room_id) then
    raise exception 'Нет доступа к таймеру';
  end if;
  select state into st from public.rooms where room_id = p_room_id for update;
  if not found then raise exception 'Комната не найдена'; end if;
  if p_timer is not null then
    if st#>>'{tournament,finishedAt}' is not null then raise exception 'Турнир завершён'; end if;
    if jsonb_typeof(p_timer) <> 'object' then raise exception 'Некорректный таймер'; end if;
    ti := public.vp_json_fields(p_timer, array['isRunning','isPaused','levelIndex','levelEndAt',
      'pauseRemainingSec','breakUntil','savedRemainingSec','finalTableActive']);
    if ti <> p_timer then raise exception 'Допустимы только поля таймера'; end if;
    foreach k in array array['isRunning','isPaused','finalTableActive'] loop
      if ti ? k and jsonb_typeof(ti->k) <> 'boolean' then raise exception 'Некорректный флаг таймера'; end if;
    end loop;
    foreach k in array array['levelIndex','levelEndAt','pauseRemainingSec','breakUntil','savedRemainingSec'] loop
      v := ti->k;
      if v is not null and v <> 'null'::jsonb and
        (jsonb_typeof(v) <> 'number' or (v::text)::numeric < 0 or (v::text)::numeric <> trunc((v::text)::numeric)) then
        raise exception 'Некорректное время/уровень';
      end if;
    end loop;
    if not ti ? 'levelIndex' or ti->'levelIndex' = 'null'::jsonb or
      (ti->>'levelIndex')::numeric >= greatest(1, jsonb_array_length(coalesce(st#>'{structure,levels}', '[]'))) then
      raise exception 'Некорректный уровень';
    end if;
    -- Меняем только часы; игроки, долги, структура и настройки остаются в БД.
    st := jsonb_set(st, '{timer}', ti);
    st := jsonb_set(st, '{_savedAt}', to_jsonb(greatest(
      floor(extract(epoch from clock_timestamp()) * 1000), coalesce((st->>'_savedAt')::numeric, 0) + 1)));
    update public.rooms set state = st where room_id = p_room_id returning state into st;
  end if;
  return public.vp_timer_projection(st);
end;
$$;

-- Блокировка доступна назначенному оператору только для автотика.
create or replace function public.try_acquire_room_lock(
  p_room_id text, p_owner text, p_ttl_seconds integer default 6
)
returns table(lock_owner text, lock_expires_at timestamptz)
language sql security definer set search_path = public as $$
  with upd as (
    update public.rooms r set lock_owner = p_owner,
      lock_expires_at = now() + make_interval(secs => least(greatest(p_ttl_seconds, 1), 30))
    where r.room_id = p_room_id
      and (public.is_admin() or public.vp_operator_room_access(p_room_id))
      and (r.lock_owner is null or r.lock_owner = p_owner or r.lock_expires_at < now())
    returning r.lock_owner, r.lock_expires_at
  )
  select u.lock_owner, u.lock_expires_at from upd u
  union all
  select r.lock_owner, r.lock_expires_at from public.rooms r
  where r.room_id = p_room_id and (public.is_admin() or public.vp_operator_room_access(p_room_id))
    and not exists (select 1 from upd)
  limit 1;
$$;

revoke all on function public.vp_json_fields(jsonb,text[]), public.vp_timer_projection(jsonb,boolean),
  public.vp_operator_room_access(text), public.vp_operator_rooms(), public.vp_operator_timer(text,jsonb),
  public.vp_display_rooms(text[]) from public, anon, authenticated;
grant execute on function public.vp_operator_rooms(), public.vp_operator_timer(text,jsonb) to authenticated;
grant execute on function public.vp_display_rooms(text[]) to anon, authenticated;
revoke all on function public.try_acquire_room_lock(text,text,integer) from public, anon;
grant execute on function public.try_acquire_room_lock(text,text,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
