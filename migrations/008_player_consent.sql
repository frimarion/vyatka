-- ═══════════════════════════════════════════════════════════════════════════
-- Согласия игрока: журнал и отметки в профиле (152-ФЗ)
--
-- Схема снята с дойловской (migration_consent_log + _photo_ + _marketing_),
-- но с двумя отличиями. Первое: журнал пишет не клиент по player_id, а RPC по
-- токену сессии — у Вятки игрок ходит в базу только с ним, и принимать «чей
-- это id» с клиента значит разрешить проставить согласие за любого. Второе:
-- версия согласия живёт и в журнале, и в профиле — по профилю приложение
-- понимает, что редакция сменилась и согласие надо взять заново.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.players
  add column if not exists pd_consent_version   text,
  add column if not exists pd_consent_at        timestamptz,
  add column if not exists marketing_consent    boolean not null default false;

-- photo_consent уже есть в 001_init.sql

-- ── Журнал согласий: только добавление ────────────────────────────────────
-- Доказывать наличие согласия обязан оператор (п. 10.2 Политики), поэтому
-- строки не обновляются и не удаляются: отзыв согласия — это новая строка
-- с agreed = false, а не правка старой.
create table if not exists public.consent_log (
  id              bigserial   primary key,
  player_id       bigint      not null references public.players (id) on delete cascade,
  consent_type    text        not null check (consent_type in ('pd', 'photo', 'marketing')),
  agreed          boolean     not null default true,
  consent_version text        not null,
  agreed_at       timestamptz not null default now(),
  source          text        not null check (source in ('tg', 'vk', 'email')),
  user_agent      text
);

create index if not exists consent_log_player_idx on public.consent_log (player_id, agreed_at desc);

alter table public.consent_log enable row level security;

-- Читает только админ — для отчётности. Пишет только RPC ниже (security definer).
drop policy if exists consent_log_select_admin on public.consent_log;
create policy consent_log_select_admin on public.consent_log
  for select to authenticated using (public.is_admin());

-- ── Запись согласия ───────────────────────────────────────────────────────
-- Согласие на ПД обязательно (без него в приложение не пускают), фото и
-- рассылка — отдельные и необязательные: п. 10.2 требует, чтобы согласие было
-- конкретным и предметным, а одна галочка на всё это требование не выполняет.
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
  v_id bigint := public.vp_session_player(p_token);
  v_ua text   := left(coalesce(p_user_agent, ''), 400);
begin
  if v_id is null then
    raise exception 'no_session';
  end if;
  if coalesce(btrim(p_consent_version), '') = '' then
    raise exception 'no_version';
  end if;
  if p_source not in ('tg', 'vk', 'email') then
    raise exception 'invalid_source';
  end if;

  insert into public.consent_log (player_id, consent_type, agreed, consent_version, source, user_agent)
  values (v_id, 'pd', true, p_consent_version, p_source, nullif(v_ua, ''));

  if p_photo_consent then
    insert into public.consent_log (player_id, consent_type, agreed, consent_version, source, user_agent)
    values (v_id, 'photo', true, p_consent_version, p_source, nullif(v_ua, ''));
  end if;

  if p_marketing_consent then
    insert into public.consent_log (player_id, consent_type, agreed, consent_version, source, user_agent)
    values (v_id, 'marketing', true, p_consent_version, p_source, nullif(v_ua, ''));
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

-- ── Профиль игрока отдаёт отметки о согласии ──────────────────────────────
-- Приложение по ним решает, показывать ли экран согласия: у тех, кто завёлся
-- до этой миграции, pd_consent_at пуст, и согласие надо взять при первом входе.
create or replace function public.vp_player_json(p_player_id bigint)
returns json
language sql
stable
security definer
set search_path = public
as $fn$
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
$fn$;
