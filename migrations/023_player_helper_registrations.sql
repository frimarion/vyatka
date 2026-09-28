-- ═══════════════════════════════════════════════════════════════════════════
-- Помощник записи: игрок, которому клуб доверил записывать других прямо из
-- приложения, на экране турнира («+ Игрок» и ✕ у записавшихся).
--
-- Право — флаг на игроке, не роль в profiles: помощник входит в приложение
-- как обычный игрок (сессия по токену), в админку ему не нужно.
-- Выдать/забрать: update players set can_register_others = … where id = …
--
-- Запись помощником — как запись админом из tournaments.html: лимит мест и
-- флаг финала месяца не мешают. Закрытый турнир (past/cancelled/draft) —
-- мешает: там записи правит только админ.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.players
  add column if not exists can_register_others boolean not null default false;

-- Снимок игрока — тот же, что в 009, плюс флаг: по нему приложение решает,
-- показывать ли кнопки помощника.
create or replace function public.vp_player_json(p_player_id bigint)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'id', p.id,
    'name', p.name,
    'full_name', p.full_name,
    'phone', p.phone,
    'tg_id', p.tg_id,
    'tg_username', p.tg_username,
    'vk_id', p.vk_id,
    'vk_username', p.vk_username,
    'email', case when p.email_verified then p.email else null end,
    'auth_provider', p.auth_provider,
    'photo_url', p.photo_url,
    'games_played', p.games_played,
    'pd_consent_at', p.pd_consent_at,
    'pd_consent_version', p.pd_consent_version,
    'photo_consent', p.photo_consent,
    'marketing_consent', p.marketing_consent,
    'can_register_others', p.can_register_others
  )
  from public.players p where p.id = p_player_id;
$$;

-- Проверка сессии + права. Возвращает id помощника.
create or replace function public._vp_helper(p_token text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint := public.vp_session_player(p_token);
begin
  if not exists (select 1 from public.players where id = v_id and can_register_others) then
    raise exception 'not_allowed';
  end if;
  return v_id;
end;
$$;

-- Поиск игрока. Шаблоны приходят готовыми (как набрали + транслиты, см.
-- searchVariants в core.js) — так же ищет tournaments.html.
create or replace function public.vp_app_helper_search(p_token text, p_patterns text[])
returns table (id bigint, name text, full_name text)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._vp_helper(p_token);
  return query
    select p.id, p.name, p.full_name
      from public.players p
     where exists (
       select 1 from unnest(coalesce(p_patterns, '{}')) q
        where length(q) >= 2
          and (p.name ilike '%' || q || '%' or p.full_name ilike '%' || q || '%'))
     order by p.name
     limit 20;
end;
$$;

-- Записать (p_on = true) или снять (false) игрока.
create or replace function public.vp_app_helper_set_reg(
  p_token text, p_tournament_id bigint, p_player_id bigint, p_on boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_count  integer;
begin
  perform public._vp_helper(p_token);

  select t.status into v_status from public.tournaments t where t.id = p_tournament_id;
  if v_status is null then
    raise exception 'tournament_not_found';
  end if;
  if v_status not in ('open', 'running') then
    raise exception 'registration_closed';
  end if;
  if not exists (select 1 from public.players where id = p_player_id) then
    raise exception 'player_not_found';
  end if;

  if p_on then
    insert into public.registrations (tournament_id, player_id, status)
    values (p_tournament_id, p_player_id, 'registered')
    on conflict (tournament_id, player_id)
      do update set status = 'registered', created_at = now();
  else
    update public.registrations
       set status = 'cancelled'
     where tournament_id = p_tournament_id and player_id = p_player_id;
    perform public.vp_unsync_registration(p_tournament_id, p_player_id);
  end if;

  select registered_count into v_count from public.tournaments where id = p_tournament_id;
  return json_build_object('registered', p_on, 'registered_count', coalesce(v_count, 0));
end;
$$;

revoke all on function public._vp_helper(text) from public, anon, authenticated;
revoke all on function public.vp_app_helper_search(text, text[]) from public;
revoke all on function public.vp_app_helper_set_reg(text, bigint, bigint, boolean) from public;
grant execute on function public.vp_app_helper_search(text, text[]) to anon, authenticated;
grant execute on function public.vp_app_helper_set_reg(text, bigint, bigint, boolean) to anon, authenticated;

-- Первый помощник — Lucky fish.
update public.players set can_register_others = true where id = 4 and name = 'Lucky fish';
