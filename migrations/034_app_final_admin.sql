-- ═══════════════════════════════════════════════════════════════════════════
-- Управление финалом месяца из приложения игрока — как у Дойла в tg-app.
--
-- Право — флаг на игроке, как can_register_others (023): организатор входит
-- в приложение обычным игроком по токену, в админку ему для этого не нужно.
-- Выдать/забрать: update players set can_manage_finals = … where id = …
--
-- Действия те же, что у админа в tournaments.html (033): открыть/закрыть
-- подтверждения, подтвердить, исключить, вернуть финалиста. Тело действий
-- вынесено в _vp_final_apply, чтобы обе точки входа делали одно и то же.
--
-- Применять после 033. Идемпотентно.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.players
  add column if not exists can_manage_finals boolean not null default false;

-- Снимок игрока — как в 023, плюс флаг: по нему приложение показывает кнопки.
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
    'can_register_others', p.can_register_others,
    'can_manage_finals', p.can_manage_finals
  )
  from public.players p where p.id = p_player_id;
$$;

-- ── Действия над финалистом, без проверки прав ─────────────────────────────
-- Права проверяет вызывающий: vp_final_admin_set (админ) или
-- vp_app_final_admin_set (игрок с can_manage_finals).
create or replace function public._vp_final_apply(p_tournament_id bigint, p_player_id bigint, p_action text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.tournaments where id = p_tournament_id and is_monthly_final) then
    raise exception 'not_a_final';
  end if;
  if p_action not in ('confirm', 'exclude', 'reset') then raise exception 'bad_action'; end if;

  -- Решение организатора — в группу не пишем, пост в канале правим.
  perform set_config('vp.final_notify', 'silent', true);

  if p_action = 'confirm' then
    delete from public.final_declines where tournament_id = p_tournament_id and player_id = p_player_id;
    insert into public.registrations (tournament_id, player_id, status)
    values (p_tournament_id, p_player_id, 'registered')
    on conflict (tournament_id, player_id)
      do update set status = 'registered', created_at = now();
  else
    if p_action = 'exclude' then
      insert into public.final_declines (tournament_id, player_id, status)
      values (p_tournament_id, p_player_id, 'approved')
      on conflict (tournament_id, player_id) do update set status = 'approved';
    else
      delete from public.final_declines where tournament_id = p_tournament_id and player_id = p_player_id;
    end if;
    update public.registrations set status = 'cancelled'
     where tournament_id = p_tournament_id and player_id = p_player_id and status = 'registered';
    perform public.vp_unsync_registration(p_tournament_id, p_player_id);
  end if;

  perform set_config('vp.final_notify', '', true);
  return json_build_object('ok', true);
end;
$$;
revoke all on function public._vp_final_apply(bigint, bigint, text) from public, anon, authenticated;

create or replace function public._vp_final_gate(p_tournament_id bigint, p_open boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tournaments
     set final_confirmations_open = coalesce(p_open, false),
         final_confirmations_opened_at = case when p_open
           then coalesce(final_confirmations_opened_at, now()) else final_confirmations_opened_at end
   where id = p_tournament_id and is_monthly_final;
  if not found then raise exception 'not_a_final'; end if;
  return json_build_object('ok', true, 'open', coalesce(p_open, false));
end;
$$;
revoke all on function public._vp_final_gate(bigint, boolean) from public, anon, authenticated;

-- ── Точки входа админки (033) — теперь через общие тела ────────────────────
create or replace function public.vp_final_admin_set(p_tournament_id bigint, p_player_id bigint, p_action text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  return public._vp_final_apply(p_tournament_id, p_player_id, p_action);
end;
$$;

create or replace function public.vp_final_set_confirmations(p_tournament_id bigint, p_open boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  return public._vp_final_gate(p_tournament_id, p_open);
end;
$$;

-- ── Точки входа приложения ─────────────────────────────────────────────────
create or replace function public._vp_final_manager(p_token text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint := public.vp_session_player(p_token);
begin
  if not exists (select 1 from public.players where id = v_id and can_manage_finals) then
    raise exception 'not_allowed';
  end if;
  return v_id;
end;
$$;
revoke all on function public._vp_final_manager(text) from public, anon, authenticated;

create or replace function public.vp_app_final_admin_set(p_token text, p_tournament_id bigint, p_player_id bigint, p_action text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._vp_final_manager(p_token);
  return public._vp_final_apply(p_tournament_id, p_player_id, p_action);
end;
$$;

create or replace function public.vp_app_final_set_confirmations(p_token text, p_tournament_id bigint, p_open boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._vp_final_manager(p_token);
  return public._vp_final_gate(p_tournament_id, p_open);
end;
$$;

-- Исключённые — чтобы организатор в приложении мог вернуть игрока.
create or replace function public.vp_app_final_excluded(p_token text, p_tournament_id bigint)
returns table (player_id bigint, name text)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public._vp_final_manager(p_token);
  return query
    select d.player_id, p.name
      from public.final_declines d join public.players p on p.id = d.player_id
     where d.tournament_id = p_tournament_id and d.status = 'approved'
     order by d.created_at;
end;
$$;

revoke all on function public.vp_app_final_admin_set(text, bigint, bigint, text) from public;
revoke all on function public.vp_app_final_set_confirmations(text, bigint, boolean) from public;
revoke all on function public.vp_app_final_excluded(text, bigint) from public;
grant execute on function public.vp_app_final_admin_set(text, bigint, bigint, text) to anon, authenticated;
grant execute on function public.vp_app_final_set_confirmations(text, bigint, boolean) to anon, authenticated;
grant execute on function public.vp_app_final_excluded(text, bigint) to anon, authenticated;

-- Первый организатор финалов — Alexander Zakharov (tg @fream1).
update public.players set can_manage_finals = true where id = 2 and tg_username = 'fream1';

notify pgrst, 'reload schema';
