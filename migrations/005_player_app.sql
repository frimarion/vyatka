-- ═══════════════════════════════════════════════════════════════════════════
-- Приложение игрока (app.html) — вход через Telegram, запись на турниры.
--
-- 001_init.sql оставил дыру: players и registrations наружу не отдаются
-- («Запись через мини-апп пойдёт позже отдельной edge-функцией»). Здесь она
-- закрывается — но не edge-функцией, а обычными SECURITY DEFINER RPC: весь
-- обмен и так идёт через PostgREST, лишний рантайм заводить незачем.
--
-- Главное отличие от дойловской схемы: там клиент присылает свой tg_id как
-- «доказательство» владения игроком, и этого достаточно. Telegram-id — не
-- секрет и перебирается числом, то есть чужую запись можно снять скриптом.
-- Здесь проверяется подпись initData ботовым токеном (HMAC, как в документации
-- Telegram), а дальше живёт сессия с токеном: остальные вызовы ходят с ней.
--
-- Применять после 001_init.sql. Идемпотентно.
--
-- ⚠ Без ботового токена вход не заработает — внизу файла одна строка,
--   которую надо заполнить своим значением.
-- ═══════════════════════════════════════════════════════════════════════════

-- hmac / digest / gen_random_bytes — из pgcrypto. Где она стоит, зависит от
-- инсталляции: в чистой базе это public, у Supabase по умолчанию — схема
-- extensions. Поэтому функции, которые ими пользуются, объявлены с
-- `search_path = public, extensions`: без второй схемы вход падал бы на
-- «function hmac does not exist», и причину пришлось бы искать в подписи.
create extension if not exists pgcrypto;

-- ── Поля игрока, нужные приложению ─────────────────────────────────────────
-- tg_id уже есть в 001_init.sql (unique). Остальное — то, что приходит из
-- Telegram и что игрок правит у себя в профиле.
alter table public.players add column if not exists tg_username text;
alter table public.players add column if not exists photo_url   text;
alter table public.players add column if not exists updated_at  timestamptz not null default now();

drop trigger if exists players_touch_updated_at on public.players;
create trigger players_touch_updated_at
  before update on public.players
  for each row execute function public.touch_updated_at();

-- ── Поля турнира, которые показывает карточка ──────────────────────────────
alter table public.tournaments add column if not exists description    text;
alter table public.tournaments add column if not exists late_reg_level integer;

-- ═══════════════════════════════════════════════════════════════════════════
-- Секреты и сессии
-- ═══════════════════════════════════════════════════════════════════════════

-- Ботовый токен. Таблица без RLS-политик и без грантов: читать её может только
-- SECURITY DEFINER-функция, то есть ни anon, ни authenticated до неё не дотянутся.
create table if not exists public.app_secrets (
  key    text primary key,
  value  text not null
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

-- Сессия приложения. Хранится хеш токена, а не сам токен: утёкший дамп базы
-- тогда не даёт входа от имени игрока.
create table if not exists public.player_sessions (
  token_hash  text primary key,
  player_id   bigint not null references public.players (id) on delete cascade,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index if not exists player_sessions_player_idx on public.player_sessions (player_id);

alter table public.player_sessions enable row level security;
revoke all on public.player_sessions from anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- Проверка подписи Telegram
-- ═══════════════════════════════════════════════════════════════════════════

-- initData приходит percent-encoded, а в строку для подписи значения входят
-- уже раскодированными. Готового urldecode в постгресе нет — собираем из
-- побайтового разбора: каждый %XX превращается в шестнадцатеричный байт, всё
-- остальное берётся как есть, и результат читается как UTF-8 (в именах игроков
-- кириллица, побайтовая склейка её бы порвала).
create or replace function public.vp_url_decode(p_data text)
returns text
language sql
immutable
as $$
  select coalesce(
    convert_from(
      decode(string_agg(
        case when length(m[1]) = 1
             then encode(convert_to(m[1], 'utf8'), 'hex')
             else substring(m[1] from 2)
        end, '' order by ord), 'hex'),
      'utf8'),
    '')
  from regexp_matches(replace(coalesce(p_data, ''), '+', ' '), '%[0-9a-fA-F]{2}|.', 'g')
       with ordinality as t(m, ord);
$$;

-- Строка для подписи: все поля кроме hash (и, опционально, кроме signature),
-- «ключ=значение», отсортированы по ключу, склеены переводом строки.
create or replace function public.vp_tg_check_string(p_init_data text, p_skip_signature boolean)
returns text
language sql
immutable
as $$
  select string_agg(kv.k || '=' || kv.v, E'\n' order by kv.k)
    from (
      select split_part(pair, '=', 1) as k,
             public.vp_url_decode(substring(pair from strpos(pair, '=') + 1)) as v
        from unnest(string_to_array(coalesce(p_init_data, ''), '&')) as pair
       where strpos(pair, '=') > 1
    ) kv
   where kv.k <> 'hash'
     and (not p_skip_signature or kv.k <> 'signature');
$$;

-- Возвращает JSON поля user из initData, если подпись сошлась. Иначе — ошибка.
--
-- Документация Telegram говорит «все поля кроме hash», но поле signature
-- (оно появилось для сторонней Ed25519-проверки) часть клиентов в строку не
-- кладёт. Поэтому считаем оба варианта и принимаем любой сошедшийся: иначе
-- вход ломался бы на части телефонов и выглядел бы как «бот сломался».
create or replace function public.vp_tg_verify(p_init_data text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_token  text;
  v_hash   text;
  v_secret bytea;
  v_when   bigint;
  v_user   text;
begin
  select value into v_token from public.app_secrets where key = 'tg_bot_token';
  if v_token is null or v_token = '' then
    raise exception 'tg_bot_token_not_configured';
  end if;

  select public.vp_url_decode(substring(pair from strpos(pair, '=') + 1))
    into v_hash
    from unnest(string_to_array(coalesce(p_init_data, ''), '&')) as pair
   where split_part(pair, '=', 1) = 'hash';
  if v_hash is null or v_hash = '' then
    raise exception 'init_data_invalid';
  end if;

  -- secret_key = HMAC_SHA256(ключ "WebAppData", данные — ботовый токен)
  v_secret := hmac(convert_to(v_token, 'utf8'), convert_to('WebAppData', 'utf8'), 'sha256');

  if lower(v_hash) <> encode(hmac(convert_to(public.vp_tg_check_string(p_init_data, false), 'utf8'), v_secret, 'sha256'), 'hex')
     and
     lower(v_hash) <> encode(hmac(convert_to(public.vp_tg_check_string(p_init_data, true), 'utf8'), v_secret, 'sha256'), 'hex')
  then
    raise exception 'init_data_invalid';
  end if;

  -- Подпись вечная: без проверки возраста перехваченная строка открывала бы
  -- вход и через год.
  select public.vp_url_decode(substring(pair from strpos(pair, '=') + 1))::bigint
    into v_when
    from unnest(string_to_array(p_init_data, '&')) as pair
   where split_part(pair, '=', 1) = 'auth_date';
  if v_when is null or v_when < extract(epoch from now()) - 86400 then
    raise exception 'init_data_expired';
  end if;

  select public.vp_url_decode(substring(pair from strpos(pair, '=') + 1))
    into v_user
    from unnest(string_to_array(p_init_data, '&')) as pair
   where split_part(pair, '=', 1) = 'user';
  if v_user is null or v_user = '' then
    raise exception 'init_data_invalid';
  end if;

  return v_user::jsonb;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Сессия
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.vp_session_player(p_token text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id bigint;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'not_authorized';
  end if;
  update public.player_sessions
     set last_seen = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and expires_at > now()
  returning player_id into v_id;
  if v_id is null then
    raise exception 'not_authorized';
  end if;
  return v_id;
end;
$$;

-- Снимок игрока для приложения. Собран в одном месте: логин и «обнови меня»
-- обязаны отдавать одинаковый объект, иначе экран после входа и после
-- перезагрузки расходятся.
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
    'photo_url', p.photo_url,
    'games_played', p.games_played
  )
  from public.players p where p.id = p_player_id;
$$;

-- Вход. Подпись проверена — дальше игрок ищется по tg_id, а если такого нет,
-- заводится новый. Имя берётся из Telegram, но только для нового: игрок мог
-- переименоваться в клубе, и вход не должен возвращать ему телеграмное имя.
create or replace function public.vp_app_login(p_init_data text, p_name text default null)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user   jsonb;
  v_tg_id  bigint;
  v_name   text;
  v_player public.players%rowtype;
  v_token  text;
  v_until  timestamptz;
begin
  v_user  := public.vp_tg_verify(p_init_data);
  v_tg_id := (v_user ->> 'id')::bigint;
  if v_tg_id is null then
    raise exception 'init_data_invalid';
  end if;

  select * into v_player from public.players where tg_id = v_tg_id;

  if v_player.id is null then
    v_name := nullif(btrim(coalesce(
      p_name,
      btrim(concat_ws(' ', v_user ->> 'first_name', v_user ->> 'last_name')),
      v_user ->> 'username'
    )), '');
    if v_name is null or length(v_name) < 2 or length(v_name) > 60 then
      raise exception 'invalid_name';
    end if;

    -- Игрок уже может быть в базе: его завёл оператор за столом, руками, без
    -- tg_id. Приклеиваемся к этой строке по свёрнутому имени, иначе в клубе
    -- появится второй такой же человек и его турниры разъедутся на двоих.
    select * into v_player from public.players
     where name_key = regexp_replace(lower(translate(v_name, 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g')
       and tg_id is null;

    if v_player.id is null then
      -- Имя занято живым аккаунтом — значит это другой человек с тем же именем.
      -- Вернуть unique violation нельзя: приложение покажет «ошибка базы»
      -- вместо «придумай другое имя».
      if exists (
        select 1 from public.players
         where name_key = regexp_replace(lower(translate(v_name, 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g')
      ) then
        raise exception 'name_taken';
      end if;
      insert into public.players (name, tg_id, tg_username, photo_url)
      values (v_name, v_tg_id, v_user ->> 'username', nullif(v_user ->> 'photo_url', ''))
      returning * into v_player;
    else
      update public.players
         set tg_id       = v_tg_id,
             tg_username = coalesce(v_user ->> 'username', tg_username),
             photo_url   = coalesce(photo_url, nullif(v_user ->> 'photo_url', ''))
       where id = v_player.id
      returning * into v_player;
    end if;
  else
    update public.players
       set tg_username = coalesce(v_user ->> 'username', tg_username),
           photo_url   = coalesce(photo_url, nullif(v_user ->> 'photo_url', ''))
     where id = v_player.id
    returning * into v_player;
  end if;

  -- Протухшие сессии убираем здесь же: отдельного шедулера в клубе нет.
  delete from public.player_sessions where expires_at < now();

  v_token := encode(gen_random_bytes(32), 'hex');
  v_until := now() + interval '180 days';
  insert into public.player_sessions (token_hash, player_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_player.id, v_until);

  return json_build_object(
    'token', v_token,
    'expires_at', v_until,
    'player', public.vp_player_json(v_player.id)
  );
end;
$$;

create or replace function public.vp_app_logout(p_token text)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.player_sessions
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Данные игрока
-- ═══════════════════════════════════════════════════════════════════════════

-- Профиль, свои записи и короткая история. Одним вызовом, а не тремя: при
-- открытии приложения нужно всё сразу, а сеть в зале бывает узкой.
create or replace function public.vp_app_me(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint := public.vp_session_player(p_token);
  v_key text;
begin
  select name_key into v_key from public.players where id = v_id;

  return json_build_object(
    'player', public.vp_player_json(v_id),
    'registrations', coalesce((
      select json_agg(r.tournament_id order by r.created_at)
        from public.registrations r
       where r.player_id = v_id and r.status = 'registered'
    ), '[]'::json),
    -- Сыгранное берём из снимков CRM: комнату могли сбросить, а отчёт остаётся.
    -- Игрока без player_id (его вписали руками) подбираем по свёрнутому имени —
    -- так же, как это делает CRM.
    'history', coalesce((
      select json_agg(h order by h.played_at desc)
        from (
          select tr.name, tr.played_at, trp.place, trp.ko, trp.points, trp.entries
            from public.tournament_result_players trp
            join public.tournament_results tr on tr.id = trp.result_id
           where trp.player_id = v_id or (trp.player_id is null and trp.name_key = v_key)
           order by tr.played_at desc
           limit 30
        ) h
    ), '[]'::json)
  );
end;
$$;

create or replace function public.vp_app_update_profile(
  p_token     text,
  p_name      text default null,
  p_full_name text default null,
  p_phone     text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id   bigint := public.vp_session_player(p_token);
  v_name text   := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_name is not null then
    if length(v_name) < 2 or length(v_name) > 60 or v_name ~ '<[^>]+>' then
      raise exception 'invalid_name';
    end if;
    -- name_key уникален: под одним именем в клубе один человек, иначе список
    -- за столом и отчёт перестают сходиться.
    if exists (
      select 1 from public.players
       where id <> v_id
         and name_key = regexp_replace(lower(translate(v_name, 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g')
    ) then
      raise exception 'name_taken';
    end if;
  end if;

  update public.players
     set name      = coalesce(v_name, name),
         full_name = coalesce(nullif(btrim(coalesce(p_full_name, '')), ''), full_name),
         phone     = coalesce(nullif(btrim(coalesce(p_phone, '')), ''), phone)
   where id = v_id;

  return public.vp_player_json(v_id);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Расписание и состав
-- ═══════════════════════════════════════════════════════════════════════════

-- Кто записан. Наружу уходят только имена: телефон и полное имя — данные клуба,
-- в списке участников им делать нечего.
create or replace function public.vp_tournament_roster(p_tournament_id bigint)
returns table (player_id bigint, name text, registered_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.player_id, p.name, r.created_at
    from public.registrations r
    join public.players p on p.id = r.player_id
    join public.tournaments t on t.id = r.tournament_id
   where r.tournament_id = p_tournament_id
     and r.status = 'registered'
     and t.status in ('open', 'running', 'past')
   order by r.created_at;
$$;

-- Как закончился вечер. Отдаётся только по завершённому турниру и только из
-- снимка CRM: живая комната — рабочий стол оператора, показывать её игрокам
-- посреди правок мест незачем. Денег в ответе нет — снимок их хранит, но
-- оплата это дело клуба, а не соседа по столу.
create or replace function public.vp_tournament_results(p_tournament_id bigint)
returns table (place integer, name text, ko integer, points integer)
language sql
stable
security definer
set search_path = public
as $$
  select trp.place, trp.name, trp.ko, trp.points
    from public.tournament_result_players trp
    join public.tournament_results tr on tr.id = trp.result_id
   where tr.tournament_id = p_tournament_id
     and exists (select 1 from public.tournaments t
                  where t.id = p_tournament_id and t.status = 'past')
   order by (trp.place is null), trp.place;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Запись и отмена
-- ═══════════════════════════════════════════════════════════════════════════

-- Запись. Слоты считаются под FOR UPDATE: два телефона, нажавшие «Записаться»
-- одновременно, иначе оба пролезают в последнее место.
create or replace function public.vp_app_register(p_token text, p_tournament_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      bigint := public.vp_session_player(p_token);
  v_slots   integer;
  v_status  text;
  v_taken   integer;
  v_count   integer;
begin
  select t.slots, t.status into v_slots, v_status
    from public.tournaments t where t.id = p_tournament_id
     for update;
  if v_status is null then
    raise exception 'tournament_not_found';
  end if;
  if v_status not in ('open', 'running') then
    raise exception 'registration_closed';
  end if;

  if v_slots is not null then
    select count(*) into v_taken
      from public.registrations
     where tournament_id = p_tournament_id and status = 'registered';
    if v_taken >= v_slots and not exists (
      select 1 from public.registrations
       where tournament_id = p_tournament_id and player_id = v_id and status = 'registered'
    ) then
      raise exception 'tournament_full';
    end if;
  end if;

  -- Повторная запись после отмены — это update строки, а не вторая строка:
  -- пара (турнир, игрок) уникальна.
  insert into public.registrations (tournament_id, player_id, status)
  values (p_tournament_id, v_id, 'registered')
  on conflict (tournament_id, player_id)
    do update set status = 'registered', created_at = now();

  select registered_count into v_count from public.tournaments where id = p_tournament_id;
  return json_build_object('registered', true, 'registered_count', coalesce(v_count, 0));
end;
$$;

-- Отмена. Строка не удаляется, а гасится: запись хранит, что человек собирался
-- и передумал, — по ней видно, кто отваливается перед вечером.
create or replace function public.vp_app_cancel(p_token text, p_tournament_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    bigint := public.vp_session_player(p_token);
  v_count integer;
begin
  update public.registrations
     set status = 'cancelled'
   where tournament_id = p_tournament_id and player_id = v_id;

  perform public.vp_unsync_registration(p_tournament_id, v_id);

  select registered_count into v_count from public.tournaments where id = p_tournament_id;
  return json_build_object('registered', false, 'registered_count', coalesce(v_count, 0));
end;
$$;

-- Отменивший должен уехать и из открытой комнаты — иначе оператор ищет за
-- столом человека, который отписался час назад. Но только пока он не тронут
-- за столом: отмеченного «пришёл», с реентри или вылетом, трогать нельзя —
-- статистика вечера уже на нём.
create or replace function public.vp_unsync_registration(p_tournament_id bigint, p_player_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room  text;
  v_state jsonb;
begin
  -- Из приложения функцию вызывает vp_app_cancel уже под проверенной сессией.
  -- Со стороны админки (tournaments.html снимает регистрацию за игрока) звонит
  -- живой пользователь — ему нужны права на этот турнир.
  if auth.uid() is not null and not public.can_access_tournament(p_tournament_id) then
    raise exception 'permission denied';
  end if;

  select t.room_id into v_room from public.tournaments t where t.id = p_tournament_id;
  if v_room is null then return; end if;

  select r.state into v_state from public.rooms r where r.room_id = v_room for update;
  if v_state is null then return; end if;

  update public.rooms r
     set state = jsonb_set(v_state, '{players}', coalesce((
           select jsonb_agg(pl)
             from jsonb_array_elements(coalesce(v_state -> 'players', '[]'::jsonb)) as pl
            where not (
              (pl ->> 'player_id')::bigint is not distinct from p_player_id
              and coalesce((pl ->> 'present')::boolean, false) = false
              and coalesce((pl ->> 'reentries')::int, 0) = 0
              and pl ->> 'bustOrder' is null
            )
         ), '[]'::jsonb))
   where r.room_id = v_room;
end;
$$;

-- Регистрация доезжает в комнату и при повторной записи после отмены: триггер
-- из 001_init.sql висел только на INSERT, а повторная запись — это UPDATE.
drop trigger if exists registrations_sync_room on public.registrations;
create trigger registrations_sync_room
  after insert or update of status on public.registrations
  for each row when (new.status = 'registered')
  execute function public.sync_registration_to_room();

-- ═══════════════════════════════════════════════════════════════════════════
-- Права
-- ═══════════════════════════════════════════════════════════════════════════

-- Всё, что вызывает приложение, идёт под anon: у игрока нет аккаунта Supabase
-- Auth, он вообще о нём не знает. Защита — внутри функций (подпись и сессия),
-- прямого доступа к players и registrations у anon по-прежнему нет.
grant execute on function public.vp_app_login(text, text)                 to anon, authenticated;
grant execute on function public.vp_app_logout(text)                      to anon, authenticated;
grant execute on function public.vp_app_me(text)                          to anon, authenticated;
grant execute on function public.vp_app_update_profile(text, text, text, text) to anon, authenticated;
grant execute on function public.vp_app_register(text, bigint)            to anon, authenticated;
grant execute on function public.vp_app_cancel(text, bigint)              to anon, authenticated;
grant execute on function public.vp_tournament_roster(bigint)             to anon, authenticated;
grant execute on function public.vp_tournament_results(bigint)            to anon, authenticated;

-- Снять запись за игрока умеет и админка турниров — но только свой персонал:
-- внутри функции стоит проверка прав на турнир.
revoke all on function public.vp_unsync_registration(bigint, bigint) from anon, authenticated;
grant execute on function public.vp_unsync_registration(bigint, bigint) to authenticated;

-- Внутренние — наружу не отдаём.
revoke all on function public.vp_tg_verify(text)                from anon, authenticated;
revoke all on function public.vp_session_player(text)           from anon, authenticated;
revoke all on function public.vp_player_json(bigint)            from anon, authenticated;

-- ── Чего не хватало админке турниров (tournaments.html) ────────────────────
-- 001_init.sql раздал select/insert/update, но не delete: удалить турнир или
-- снять регистрацию было нечем.
drop policy if exists tournaments_delete_admin on public.tournaments;
create policy tournaments_delete_admin on public.tournaments
  for delete to authenticated using (public.is_admin());

drop policy if exists registrations_delete_access on public.registrations;
create policy registrations_delete_access on public.registrations
  for delete to authenticated using (public.can_access_tournament(tournament_id));

-- Игрока правят из админки (приклеить телефон, поправить имя).
drop policy if exists players_update_staff on public.players;
create policy players_update_staff on public.players
  for update to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ ПОСЛЕДНИЙ ШАГ — токен бота
-- Без него vp_app_login отвечает tg_bot_token_not_configured и в приложение
-- никто не войдёт. Токен выдаёт @BotFather; Mini App должен указывать на
-- страницу app.html этого клуба.
-- ═══════════════════════════════════════════════════════════════════════════
-- insert into public.app_secrets (key, value)
-- values ('tg_bot_token', '123456:ВСТАВЬ_СЮДА_ТОКЕН_БОТА')
-- on conflict (key) do update set value = excluded.value;
