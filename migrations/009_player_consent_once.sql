-- Согласие на ПД принимается один раз и после успешной записи больше не
-- переспрашивается. RPC остаётся идемпотентным: повторный запрос (двойной тап,
-- ретрай сети) не плодит строки журнала и не меняет выбранные ранее опции.

-- Более ранняя миграция авторизации тоже определяет vp_player_json. Если её
-- повторно применили после миграции согласий, эти четыре поля исчезали из
-- ответа, хотя в players оставались заполнены. Клиент видел undefined и при
-- каждом запуске снова открывал форму согласия.
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
    'marketing_consent', p.marketing_consent
  )
  from public.players p where p.id = p_player_id;
$$;

create or replace function public.vp_app_log_consent(
  p_token             text,
  p_consent_version   text,
  p_source            text,
  p_user_agent        text    default null,
  p_photo_consent     boolean default false,
  p_marketing_consent boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     bigint := public.vp_session_player(p_token);
  v_ua     text   := left(coalesce(p_user_agent, ''), 400);
  v_source text   := case when p_source = 'telegram' then 'tg' else p_source end;
begin
  if v_id is null then
    raise exception 'no_session';
  end if;
  if coalesce(btrim(p_consent_version), '') = '' then
    raise exception 'no_version';
  end if;
  if v_source not in ('tg', 'vk', 'email') then
    raise exception 'invalid_source';
  end if;

  -- Блокировка строки делает проверку и запись атомарными даже при двух
  -- одновременных запросах с одного телефона.
  perform 1 from public.players where id = v_id for update;

  if exists (
    select 1 from public.players
     where id = v_id and pd_consent_at is not null
  ) then
    return public.vp_player_json(v_id);
  end if;

  insert into public.consent_log
    (player_id, consent_type, agreed, consent_version, source, user_agent)
  values
    (v_id, 'pd', true, p_consent_version, v_source, nullif(v_ua, ''));

  if p_photo_consent then
    insert into public.consent_log
      (player_id, consent_type, agreed, consent_version, source, user_agent)
    values
      (v_id, 'photo', true, p_consent_version, v_source, nullif(v_ua, ''));
  end if;

  if p_marketing_consent then
    insert into public.consent_log
      (player_id, consent_type, agreed, consent_version, source, user_agent)
    values
      (v_id, 'marketing', true, p_consent_version, v_source, nullif(v_ua, ''));
  end if;

  update public.players
     set pd_consent_version = p_consent_version,
         pd_consent_at      = now(),
         photo_consent      = p_photo_consent,
         marketing_consent  = p_marketing_consent
   where id = v_id;

  return public.vp_player_json(v_id);
end;
$$;

revoke all on function public.vp_app_log_consent(text, text, text, text, boolean, boolean) from public;
grant execute on function public.vp_app_log_consent(text, text, text, text, boolean, boolean) to anon, authenticated;
