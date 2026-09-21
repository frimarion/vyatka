-- ═══════════════════════════════════════════════════════════════════════════
-- Вход игрока: VK ID и email — рядом с телеграмным.
--
-- 005_player_app.sql знал один способ: Mini App внутри Telegram. Но клуб живёт
-- не только в телеграме — на сайт приходят из VK и просто с телефона, и для
-- них входа не было вовсе. Здесь их становится три, и все три сходятся в одну
-- и ту же сессию из 005: снаружи меняется только то, чем человек доказал, что
-- он — это он.
--
-- Снято с дойловских unified_auth.sql / add_email_auth.sql: те же три способа,
-- та же склейка аккаунтов (find_or_create + link + merge), те же коды ошибок.
-- Разошлись в одном, и это то же расхождение, что уже было по телеграму:
--
--   У Дойла клиент присылает свой vk_id и свой email числом и строкой — сервер
--   верит на слово. Любой, кто знает чужой vk_id (а он виден в адресе страницы
--   VK), входит чужим аккаунтом из консоли браузера. Здесь наружу уходит не
--   идентификатор, а доказательство: для VK — access_token, который сервер сам
--   меняет на user_id у id.vk.com; для почты — JWT от нашего же GoTrue, чью
--   подпись сервер проверяет тем же секретом, которым её ставили. Идентификатор
--   появляется только внутри базы, и подделать его снаружи нечем.
--
-- Заодно здесь чинится то, что вытащил наружу почтовый вход: у игрока теперь
-- есть аккаунт в GoTrue (иначе некому отправить код), а «свой» в политиках 001
-- и 004 записан как «залогинен где-нибудь». Ниже «свой» становится «есть
-- строка в profiles», а профиль заводится только клубному адресу.
--
-- Применять после 005_player_app.sql. Идемпотентно.
--
-- ⚠ Внизу файла — две строки секретов (id приложения VK и секрет JWT). Без них
--   VK-вход отвечает vk_not_configured, почтовый — email_auth_not_configured.
-- ═══════════════════════════════════════════════════════════════════════════

-- Проверка VK-токена — единственное место во всей схеме, которое ходит наружу
-- по сети. Синхронно, из функции: pg_net умеет только асинхронно (запрос
-- уходит после коммита), а вход обязан ответить «да» или «нет» в том же
-- вызове. Расширение есть в образе supabase/postgres.
do $ext$
begin
  create extension if not exists http with schema extensions;
exception when others then
  raise exception 'Расширение http недоступно (%) — без него VK-вход не собрать, см. deploy/README.md', sqlerrm;
end $ext$;

-- ── Поля входа ─────────────────────────────────────────────────────────────
alter table public.players add column if not exists vk_id          bigint;
alter table public.players add column if not exists vk_username    text;
alter table public.players add column if not exists email          text;
alter table public.players add column if not exists email_verified boolean not null default false;
-- Чем человек вошёл в первый раз. Нужно не логике, а разговору: «зайди тем же
-- способом, что и в прошлый раз» — иначе в поддержку идут с «у меня пропали
-- турниры», а на деле это второй аккаунт.
alter table public.players add column if not exists auth_provider  text;

create unique index if not exists players_vk_id_uidx
  on public.players (vk_id) where vk_id is not null;

-- Неподтверждённой почты в базе быть не должно вовсе: сюда она попадает только
-- после кода из письма. Индекс частичный на случай, если адрес впишет админка
-- руками — такая почта в клубе справочная и на вход не влияет.
create unique index if not exists players_email_uidx
  on public.players (lower(email)) where email is not null and email_verified;

update public.players set auth_provider = 'telegram'
 where auth_provider is null and tg_id is not null;

-- ═══════════════════════════════════════════════════════════════════════════
-- Доказательства
-- ═══════════════════════════════════════════════════════════════════════════

-- base64url → bytea. В JWT padding отрезан, а decode(...,'base64') на непарной
-- длине падает «invalid base64 end sequence» — дописываем '=' обратно.
create or replace function public.vp_b64url_decode(p_data text)
returns bytea
language sql
immutable
as $fn$
  select decode(
    translate(p_data, '-_', '+/') ||
    repeat('=', (4 - length(p_data) % 4) % 4),
    'base64');
$fn$;

-- Секрет из app_secrets. Пустая строка и отсутствие строки — одно и то же:
-- заполнять секреты будут копипастой, и пустая вставка вероятнее пропуска.
create or replace function public.vp_secret(p_key text)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select nullif(value, '') from public.app_secrets where key = p_key;
$fn$;

-- Проверка JWT нашего GoTrue. Self-hosted подписывает HS256 тем же секретом,
-- что лежит в JWT_SECRET стека, — то есть подпись проверяется здесь же, без
-- сети и без доверия клиенту. Возвращает payload, если всё сошлось.
--
-- Почему вообще JWT, а не «клиент прислал подтверждённый email»: письмо с кодом
-- шлёт GoTrue, он же и знает, что код сошёлся. Единственное, что он про это
-- выдаёт наружу, — подписанный токен. Приложение передаёт его дальше нам, мы
-- проверяем подпись и читаем email из середины. Клиенту верить не приходится
-- ни в одной точке.
create or replace function public.vp_jwt_verify(p_jwt text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $fn$
declare
  v_secret  text;
  v_parts   text[];
  v_signed  text;
  v_expect  text;
  v_payload jsonb;
begin
  v_secret := public.vp_secret('jwt_secret');
  if v_secret is null then
    raise exception 'email_auth_not_configured';
  end if;

  v_parts := string_to_array(coalesce(p_jwt, ''), '.');
  if array_length(v_parts, 1) <> 3 then
    raise exception 'auth_token_invalid';
  end if;

  v_signed := v_parts[1] || '.' || v_parts[2];
  v_expect := translate(
    encode(hmac(convert_to(v_signed, 'utf8'), convert_to(v_secret, 'utf8'), 'sha256'), 'base64'),
    '+/', '-_');
  v_expect := replace(replace(v_expect, '=', ''), E'\n', '');

  if v_expect <> v_parts[3] then
    raise exception 'auth_token_invalid';
  end if;

  v_payload := convert_from(public.vp_b64url_decode(v_parts[2]), 'utf8')::jsonb;

  -- Протухший токен не хуже поддельного: сессию он открывать не должен.
  if coalesce((v_payload ->> 'exp')::bigint, 0) < extract(epoch from now()) then
    raise exception 'auth_token_expired';
  end if;

  return v_payload;
end;
$fn$;

-- Проверка VK-токена. Приложение отдаёт access_token, полученный VK ID SDK, а
-- user_id мы спрашиваем у самого VK — и спрашиваем со своим client_id, поэтому
-- чужой токен, выписанный на другое приложение, здесь отваливается.
create or replace function public.vp_vk_verify(p_access_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $fn$
declare
  v_client text;
  v_status integer;
  v_body   text;
  v_json   jsonb;
begin
  if p_access_token is null or length(p_access_token) < 16 then
    raise exception 'auth_token_invalid';
  end if;

  v_client := public.vp_secret('vk_client_id');
  if v_client is null then
    raise exception 'vk_not_configured';
  end if;

  -- Вечер в зале не должен вставать из-за того, что у VK долгий ответ: пять
  -- секунд и отказ понятнее, чем повисший вход.
  perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT', '3');
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '5');

  select r.status, r.content into v_status, v_body
    from extensions.http_post(
      'https://id.vk.com/oauth2/user_info',
      'client_id=' || extensions.urlencode(v_client) ||
      '&access_token=' || extensions.urlencode(p_access_token),
      'application/x-www-form-urlencoded'
    ) r;

  -- Пятисотка и обрыв — это «VK сейчас не отвечает», а не «токен плохой».
  -- Игроку это разные сообщения: во втором случае он будет жать «войти» ещё
  -- десять раз и злиться.
  if v_status is null or v_status >= 500 then
    raise exception 'vk_unreachable';
  end if;

  begin
    v_json := v_body::jsonb;
  exception when others then
    raise exception 'vk_unreachable';
  end;

  if v_json ? 'error' then
    raise exception 'auth_token_invalid';
  end if;

  v_json := coalesce(v_json -> 'user', v_json);
  if coalesce(v_json ->> 'user_id', '') = '' then
    raise exception 'auth_token_invalid';
  end if;

  return v_json;
end;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Один игрок на человека
-- ═══════════════════════════════════════════════════════════════════════════

-- Общий вход для всех трёх способов: найти по тому, чем доказали, иначе —
-- приклеиться к строке, заведённой оператором за столом, иначе — завести.
-- Отдельной функцией, а не тремя копиями, ровно по дойловской причине: пока
-- копий было три, они разошлись в мелочах, и один и тот же человек через VK и
-- через почту становился двумя игроками с раздельной статистикой.
create or replace function public.vp_find_or_create_player(
  p_tg_id       bigint default null,
  p_vk_id       bigint default null,
  p_email       text   default null,
  p_name        text   default null,
  p_tg_username text   default null,
  p_vk_username text   default null,
  p_photo_url   text   default null
)
returns public.players
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_player public.players%rowtype;
  v_name   text;
  v_key    text;
  v_email  text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  if p_tg_id is not null then
    select * into v_player from public.players where tg_id = p_tg_id;
  end if;
  if v_player.id is null and p_vk_id is not null then
    select * into v_player from public.players where vk_id = p_vk_id;
  end if;
  if v_player.id is null and v_email is not null then
    select * into v_player from public.players
     where lower(email) = v_email and email_verified;
  end if;

  -- Нашли — дописываем то, чем вошли в этот раз. Имя не трогаем: игрок мог
  -- переименоваться в клубе, и вход не должен возвращать ему имя из VK.
  if v_player.id is not null then
    update public.players set
      tg_id          = coalesce(tg_id, p_tg_id),
      vk_id          = coalesce(vk_id, p_vk_id),
      email          = coalesce(email, v_email),
      email_verified = email_verified or (email is null and v_email is not null),
      tg_username    = coalesce(p_tg_username, tg_username),
      vk_username    = coalesce(p_vk_username, vk_username),
      photo_url      = coalesce(photo_url, nullif(p_photo_url, ''))
     where id = v_player.id
    returning * into v_player;
    return v_player;
  end if;

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null or length(v_name) < 2 or length(v_name) > 60 or v_name ~ '<[^>]+>' then
    raise exception 'invalid_name';
  end if;
  v_key := regexp_replace(lower(translate(v_name, 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g');

  -- Игрока мог завести оператор руками, без единого идентификатора. Тогда это
  -- не новый человек, а тот же самый — приклеиваемся к его строке, иначе его
  -- сыгранные вечера останутся на «старом» игроке.
  select * into v_player from public.players
   where name_key = v_key
     and tg_id is null and vk_id is null and email is null;

  if v_player.id is not null then
    update public.players set
      tg_id          = coalesce(p_tg_id, tg_id),
      vk_id          = coalesce(p_vk_id, vk_id),
      email          = coalesce(v_email, email),
      email_verified = (v_email is not null) or email_verified,
      tg_username    = coalesce(p_tg_username, tg_username),
      vk_username    = coalesce(p_vk_username, vk_username),
      photo_url      = coalesce(photo_url, nullif(p_photo_url, '')),
      auth_provider  = coalesce(auth_provider,
                         case when p_tg_id is not null then 'telegram'
                              when p_vk_id is not null then 'vk'
                              else 'email' end)
     where id = v_player.id
    returning * into v_player;
    return v_player;
  end if;

  -- Имя занято живым аккаунтом — значит это другой человек с тем же именем.
  -- Отдать unique violation нельзя: приложение покажет «ошибка базы» вместо
  -- «придумай другое имя».
  if exists (select 1 from public.players where name_key = v_key) then
    raise exception 'name_taken';
  end if;

  insert into public.players (name, tg_id, vk_id, email, email_verified,
                              tg_username, vk_username, photo_url, auth_provider)
  values (v_name, p_tg_id, p_vk_id, v_email, v_email is not null,
          p_tg_username, p_vk_username, nullif(p_photo_url, ''),
          case when p_tg_id is not null then 'telegram'
               when p_vk_id is not null then 'vk'
               else 'email' end)
  returning * into v_player;

  return v_player;
end;
$fn$;

-- Выдача сессии. Была врезана в vp_app_login; теперь способов входа три, а
-- сессия у них одна — значит и код один.
create or replace function public.vp_issue_session(p_player_id bigint)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_token text;
  v_until timestamptz;
begin
  -- Протухшие сессии убираем здесь же: отдельного шедулера в клубе нет.
  delete from public.player_sessions where expires_at < now();

  v_token := encode(gen_random_bytes(32), 'hex');
  v_until := now() + interval '180 days';
  insert into public.player_sessions (token_hash, player_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), p_player_id, v_until);

  return json_build_object(
    'token', v_token,
    'expires_at', v_until,
    'player', public.vp_player_json(p_player_id)
  );
end;
$fn$;

-- Снимок игрока — теперь со способами входа: приложению надо показать в
-- профиле, что уже привязано, а что предложить привязать.
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
    'games_played', p.games_played
  )
  from public.players p where p.id = p_player_id;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Входы
-- ═══════════════════════════════════════════════════════════════════════════

-- Телеграмный вход из 005 — переписан на общие куски. Поведение то же.
create or replace function public.vp_app_login(p_init_data text, p_name text default null)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_user   jsonb;
  v_tg_id  bigint;
  v_player public.players%rowtype;
begin
  v_user  := public.vp_tg_verify(p_init_data);
  v_tg_id := (v_user ->> 'id')::bigint;
  if v_tg_id is null then
    raise exception 'init_data_invalid';
  end if;

  v_player := public.vp_find_or_create_player(
    p_tg_id       => v_tg_id,
    p_name        => coalesce(
                       p_name,
                       nullif(btrim(concat_ws(' ', v_user ->> 'first_name', v_user ->> 'last_name')), ''),
                       v_user ->> 'username'),
    p_tg_username => v_user ->> 'username',
    p_photo_url   => v_user ->> 'photo_url');

  return public.vp_issue_session(v_player.id);
end;
$fn$;

-- Вход через VK. Имя для нового игрока берём из VK, но спросить его отдельно
-- приложение всё равно умеет: в VK часто стоит «Юзер Петровичъ», а за столом
-- по такому имени человека не найти.
create or replace function public.vp_app_login_vk(p_access_token text, p_name text default null)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_user   jsonb;
  v_vk_id  bigint;
  v_player public.players%rowtype;
begin
  v_user  := public.vp_vk_verify(p_access_token);
  v_vk_id := (v_user ->> 'user_id')::bigint;
  if v_vk_id is null or v_vk_id <= 0 then
    raise exception 'auth_token_invalid';
  end if;

  v_player := public.vp_find_or_create_player(
    p_vk_id       => v_vk_id,
    p_name        => coalesce(
                       p_name,
                       nullif(btrim(concat_ws(' ', v_user ->> 'first_name', v_user ->> 'last_name')), '')),
    p_vk_username => nullif(v_user ->> 'screen_name', ''),
    p_photo_url   => nullif(coalesce(v_user ->> 'avatar', v_user ->> 'photo_200'), ''));

  return public.vp_issue_session(v_player.id);
end;
$fn$;

-- Вход по почте. p_jwt — access_token из GoTrue, выданный после кода из письма.
-- Сам код мы не видим и не проверяем: это работа GoTrue, наша — убедиться, что
-- токен подписан нашим стеком и почта в нём подтверждена.
create or replace function public.vp_app_login_email(p_jwt text, p_name text default null)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_claims jsonb;
  v_email  text;
  v_player public.players%rowtype;
begin
  v_claims := public.vp_jwt_verify(p_jwt);
  v_email  := nullif(lower(btrim(coalesce(v_claims ->> 'email', ''))), '');
  if v_email is null then
    raise exception 'auth_token_invalid';
  end if;
  -- Неподтверждённая почта в токене означает, что письмо не открывали: у
  -- GoTrue такой токен выписывается, например, при смене адреса.
  if coalesce((v_claims -> 'user_metadata' ->> 'email_verified')::boolean, true) = false then
    raise exception 'auth_token_invalid';
  end if;

  v_player := public.vp_find_or_create_player(
    p_email => v_email,
    p_name  => p_name);

  return public.vp_issue_session(v_player.id);
end;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Привязка второго способа
-- ═══════════════════════════════════════════════════════════════════════════

-- Человек вошёл через VK, а завтра откроет приложение в телеграме — и без
-- привязки увидит пустой профиль. Привязка делает оба входа одной дверью.
-- Доказательства нужны оба сразу: живая сессия (это я) и свежий токен второго
-- способа (и это тоже я).
create or replace function public.vp_app_link_vk(p_token text, p_access_token text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_id    bigint := public.vp_session_player(p_token);
  v_user  jsonb  := public.vp_vk_verify(p_access_token);
  v_vk_id bigint := (v_user ->> 'user_id')::bigint;
begin
  if v_vk_id is null or v_vk_id <= 0 then
    raise exception 'auth_token_invalid';
  end if;
  if exists (select 1 from public.players where vk_id = v_vk_id and id <> v_id) then
    raise exception 'vk_id_taken';
  end if;

  update public.players
     set vk_id       = v_vk_id,
         vk_username = coalesce(nullif(v_user ->> 'screen_name', ''), vk_username),
         photo_url   = coalesce(photo_url, nullif(coalesce(v_user ->> 'avatar', v_user ->> 'photo_200'), ''))
   where id = v_id;

  return public.vp_player_json(v_id);
end;
$fn$;

create or replace function public.vp_app_link_email(p_token text, p_jwt text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_id     bigint := public.vp_session_player(p_token);
  v_claims jsonb  := public.vp_jwt_verify(p_jwt);
  v_email  text   := nullif(lower(btrim(coalesce(v_claims ->> 'email', ''))), '');
begin
  if v_email is null then
    raise exception 'auth_token_invalid';
  end if;
  if exists (
    select 1 from public.players
     where lower(email) = v_email and email_verified and id <> v_id
  ) then
    raise exception 'email_taken';
  end if;

  update public.players
     set email = v_email, email_verified = true
   where id = v_id;

  return public.vp_player_json(v_id);
end;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Склейка двух аккаунтов
-- ═══════════════════════════════════════════════════════════════════════════

-- Человек уже успел завести два аккаунта: осенью вошёл через телеграм, зимой —
-- через VK, и турниры разъехались по двум строкам. Привязка тут не поможет
-- (идентификатор занят), и без склейки остаётся только просить администратора
-- лезть в базу руками.
--
-- Склеиваем только когда оба аккаунта доказаны в одном вызове: сессия первого
-- и свежий токен второго. У Дойла merge_accounts принимает два id от клиента и
-- верит им — то есть любой желающий может слить чужой аккаунт в свой.
create or replace function public.vp_merge_players(p_keep bigint, p_remove bigint)
returns json
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_keep   public.players%rowtype;
  v_remove public.players%rowtype;
begin
  if p_keep = p_remove then
    raise exception 'same_player';
  end if;
  -- Порядок блокировок по id, а не по ролям: две встречные склейки (он сливает
  -- в свой, тот же аккаунт сливают в другой) иначе встают в deadlock.
  perform 1 from public.players
   where id in (p_keep, p_remove) order by id for update;

  select * into v_keep   from public.players where id = p_keep;
  select * into v_remove from public.players where id = p_remove;
  if v_keep.id is null or v_remove.id is null then
    raise exception 'player_not_found';
  end if;

  -- Идентификаторы уникальны, поэтому сначала снимаем их с донора и только
  -- потом переносим: иначе update упрётся в собственный же индекс.
  update public.players
     set tg_id = null, vk_id = null, email = null, email_verified = false
   where id = p_remove;

  update public.players set
    tg_id          = coalesce(tg_id, v_remove.tg_id),
    vk_id          = coalesce(vk_id, v_remove.vk_id),
    email          = coalesce(email, v_remove.email),
    email_verified = email_verified or (email is null and v_remove.email_verified),
    tg_username    = coalesce(tg_username, v_remove.tg_username),
    vk_username    = coalesce(vk_username, v_remove.vk_username),
    photo_url      = coalesce(photo_url, v_remove.photo_url),
    full_name      = coalesce(full_name, v_remove.full_name),
    phone          = coalesce(phone, v_remove.phone),
    games_played   = coalesce(games_played, 0) + coalesce(v_remove.games_played, 0)
   where id = p_keep;

  -- Записи: те, где обе строки на один турнир, переносить некуда — у пары
  -- (турнир, игрок) уникальный индекс. Оставляем ту, что уже на выжившем.
  update public.registrations set player_id = p_keep
   where player_id = p_remove
     and tournament_id not in (select tournament_id from public.registrations where player_id = p_keep);
  delete from public.registrations where player_id = p_remove;

  -- Сыгранные вечера: снимки CRM переезжают целиком, дублей там быть не может.
  update public.tournament_result_players set player_id = p_keep where player_id = p_remove;

  delete from public.players where id = p_remove;

  return public.vp_player_json(p_keep);
end;
$fn$;

create or replace function public.vp_app_merge_vk(p_token text, p_access_token text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_keep   bigint := public.vp_session_player(p_token);
  v_user   jsonb  := public.vp_vk_verify(p_access_token);
  v_vk_id  bigint := (v_user ->> 'user_id')::bigint;
  v_remove bigint;
begin
  select id into v_remove from public.players where vk_id = v_vk_id;
  if v_remove is null then
    raise exception 'player_not_found';
  end if;
  return public.vp_merge_players(v_keep, v_remove);
end;
$fn$;

create or replace function public.vp_app_merge_email(p_token text, p_jwt text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_keep   bigint := public.vp_session_player(p_token);
  v_claims jsonb  := public.vp_jwt_verify(p_jwt);
  v_email  text   := nullif(lower(btrim(coalesce(v_claims ->> 'email', ''))), '');
  v_remove bigint;
begin
  select id into v_remove from public.players
   where lower(email) = v_email and email_verified;
  if v_remove is null then
    raise exception 'player_not_found';
  end if;
  return public.vp_merge_players(v_keep, v_remove);
end;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- «Свой» — это персонал, а не «кто угодно с аккаунтом»
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Почтовый вход игрока заводит ему аккаунт в GoTrue — иначе некому отправить
-- код. И вот тут вылезает то, чего в схеме до сих пор не было видно: политики
-- 001 и 004 писались, когда аккаунт Supabase Auth был только у персонала, и
-- «свой» в них записан как `auth.uid() is not null` — то есть «залогинен
-- где-нибудь». С появлением почтового входа под это определение попадает
-- каждый игрок, а значит ему открываются телефоны всех игроков клуба и
-- денежные отчёты CRM. Плюс триггер on_auth_user_created заводил бы каждому
-- профиль с ролью `operator`.
--
-- Чинится в две руки: профиль появляется только у клубного адреса, а «свой» в
-- политиках теперь означает «есть строка в profiles».

-- Операторов заводит админ, и адрес у них всегда клубный — форма входа в
-- админке сама дописывает домен к логину. Всё остальное, что приходит в
-- auth.users, — игроки за кодом из письма, и профиля им не полагается.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.email is null or new.email not ilike '%@vyatkapoker.ru' then
    return new;
  end if;
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$fn$;

-- Профили, которые старый триггер успел завести не персоналу, убираем — но
-- осторожно: форма входа домен дописывает, а полный адрес принимает любой,
-- то есть у настоящего оператора адрес теоретически может быть и не клубный.
-- Поэтому сносим только то, что заведомо никем не пользовано: роль по
-- умолчанию и ни одного назначения на турнир. Админа с чужим адресом и
-- работающего оператора это не трогает — их надо смотреть глазами, и о них
-- миграция скажет вслух.
do $cleanup$
declare
  v_kept integer;
begin
  delete from public.profiles p
   where p.email is not null
     and p.email not ilike '%@vyatkapoker.ru'
     and p.role = 'operator'
     and not exists (select 1 from public.tournament_operators o where o.profile_id = p.id);

  select count(*) into v_kept from public.profiles p
   where p.email is null or p.email not ilike '%@vyatkapoker.ru';

  if v_kept > 0 then
    raise notice 'Профилей с неклубным адресом осталось: % — это админы или операторы с назначениями. Проверь их руками: с этой миграции профиль означает «персонал».', v_kept;
  end if;
end $cleanup$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (select 1 from public.profiles p where p.id = auth.uid());
$fn$;

grant execute on function public.is_staff() to authenticated;

-- Игроки клуба: персональные данные, читает и правит только персонал.
drop policy if exists players_select_staff on public.players;
create policy players_select_staff on public.players
  for select to authenticated using (public.is_staff());

drop policy if exists players_write_staff on public.players;
create policy players_write_staff on public.players
  for insert to authenticated with check (public.is_staff());

drop policy if exists players_update_staff on public.players;
create policy players_update_staff on public.players
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- Снимки CRM: там суммы, долги и способы оплаты. «Любой свой» здесь значит
-- оператор, который вёл вечер, — но именно оператор, а не любой вошедший.
drop policy if exists results_read on public.tournament_results;
create policy results_read on public.tournament_results
  for select to authenticated using (public.is_staff());

drop policy if exists results_write on public.tournament_results;
create policy results_write on public.tournament_results
  for insert to authenticated with check (public.is_staff());

drop policy if exists results_update on public.tournament_results;
create policy results_update on public.tournament_results
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists result_players_read on public.tournament_result_players;
create policy result_players_read on public.tournament_result_players
  for select to authenticated using (public.is_staff());

drop policy if exists result_players_write on public.tournament_result_players;
create policy result_players_write on public.tournament_result_players
  for insert to authenticated with check (public.is_staff());

drop policy if exists result_players_update on public.tournament_result_players;
create policy result_players_update on public.tournament_result_players
  for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists result_players_delete on public.tournament_result_players;
create policy result_players_delete on public.tournament_result_players
  for delete to authenticated using (public.is_staff());

-- Макеты турниров игроку не вредны — там структура и блайнды, а не люди. Но
-- «читают все свои» и здесь значило «все залогиненные», и оставлять в схеме
-- два разных смысла одного слова — верный способ однажды ошибиться в третьем
-- месте, где это уже будет важно.
drop policy if exists blueprints_read on public.tournament_blueprints;
create policy blueprints_read on public.tournament_blueprints
  for select to authenticated using (public.is_staff());

-- Комнаты, расписание, записи и назначения операторов трогать не нужно: там
-- «свой» с самого начала проверяется через is_admin() и can_access_*, то есть
-- через profiles и tournament_operators. Аккаунт без профиля мимо них не
-- проходит.

-- ═══════════════════════════════════════════════════════════════════════════
-- Права
-- ═══════════════════════════════════════════════════════════════════════════

grant execute on function public.vp_app_login_vk(text, text)      to anon, authenticated;
grant execute on function public.vp_app_login_email(text, text)   to anon, authenticated;
grant execute on function public.vp_app_link_vk(text, text)       to anon, authenticated;
grant execute on function public.vp_app_link_email(text, text)    to anon, authenticated;
grant execute on function public.vp_app_merge_vk(text, text)      to anon, authenticated;
grant execute on function public.vp_app_merge_email(text, text)   to anon, authenticated;

-- Внутренние. vp_vk_verify наружу особенно нельзя: это исходящий запрос с
-- нашего сервера по чужому вводу.
revoke all on function public.vp_b64url_decode(text)   from anon, authenticated;
revoke all on function public.vp_secret(text)          from anon, authenticated;
revoke all on function public.vp_jwt_verify(text)      from anon, authenticated;
revoke all on function public.vp_vk_verify(text)       from anon, authenticated;
revoke all on function public.vp_issue_session(bigint) from anon, authenticated;
revoke all on function public.vp_merge_players(bigint, bigint) from anon, authenticated;
revoke all on function public.vp_find_or_create_player(bigint, bigint, text, text, text, text, text)
  from anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠ ПОСЛЕДНИЙ ШАГ — секреты
--
--   vk_client_id — id приложения VK ID: у клуба это 54782171, тот же, что в
--                  window.VP_VKID_APP (js/config.js)
--   jwt_secret   — JWT_SECRET из /opt/vyatka/.env, тот же, которым подписан
--                  ANON_KEY; им же GoTrue подписывает токены игроков, и именно
--                  его сверяет vp_jwt_verify
--
-- Порядок, домены и настройка почты в GoTrue — deploy/README.md, шаг 7.
-- ═══════════════════════════════════════════════════════════════════════════
-- insert into public.app_secrets (key, value) values
--   ('vk_client_id', '54782171'),
--   ('jwt_secret',   'ВСТАВЬ_СЮДА_JWT_SECRET')
-- on conflict (key) do update set value = excluded.value;
