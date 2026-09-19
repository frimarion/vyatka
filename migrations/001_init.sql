-- ═══════════════════════════════════════════════════════════════════════════
-- Вятка — начальная схема собственного Supabase-проекта.
-- Проект отдельный от дойловского: здесь нет ни одной дойловской таблицы,
-- имена без префиксов. Фронт ходит сюда через карту VP_TABLES (js/config.js).
--
-- Применять в SQL Editor целиком, на чистой базе. Идемпотентно: повторный
-- прогон ничего не ломает.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── Профили ────────────────────────────────────────────────────────────────
-- Строка на каждого пользователя Supabase Auth. Роль определяет права в
-- админке: admin — всё, operator — только назначенные турниры.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  role        text not null default 'operator' check (role in ('admin', 'operator')),
  created_at  timestamptz not null default now()
);

-- Профиль заводится сам при регистрации пользователя: без него человек войдёт,
-- но не получит ни одной строки по RLS и увидит пустую админку.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Игроки клуба ───────────────────────────────────────────────────────────
-- name — то, под чем игрока знают за столом, оно же уходит в rooms.state.
-- name_key — свёрнутое имя (нижний регистр, схлопнутые пробелы, е вместо ё):
-- по нему ищут дубли, потому что «Пётр  Иванов» и «петр иванов» — один человек.
create table if not exists public.players (
  id             bigserial primary key,
  name           text not null,
  name_key       text generated always as (
                   regexp_replace(lower(translate(name, 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g')
                 ) stored,
  full_name      text,
  phone          text,
  tg_id          bigint unique,
  photo_consent  boolean not null default false,
  games_played   integer not null default 0,
  created_at     timestamptz not null default now()
);

create unique index if not exists players_name_key_uidx on public.players (name_key);

-- ── Комнаты таймера ────────────────────────────────────────────────────────
-- state — то самое JSONB-состояние, которое правит админка и зеркалит дисплей.
-- lock_owner/lock_expires_at — аренда ведущего: авто-переход уровней делает
-- только держатель аренды, иначе две открытые админки двигают уровень дважды.
create table if not exists public.rooms (
  room_id          text primary key,
  state            jsonb not null default '{}'::jsonb,
  lock_owner       text,
  lock_expires_at  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists rooms_touch_updated_at on public.rooms;
create trigger rooms_touch_updated_at
  before update on public.rooms
  for each row execute function public.touch_updated_at();

-- ── Турниры ────────────────────────────────────────────────────────────────
-- room_id связывает турнир с комнатой таймера: комнату могут пересоздать,
-- турнир остаётся, поэтому назначения операторов висят на турнире.
create table if not exists public.tournaments (
  id                bigserial primary key,
  name              text not null,
  date              timestamptz,
  status            text not null default 'draft'
                      check (status in ('draft', 'open', 'running', 'past', 'cancelled')),
  entry_fee         integer not null default 1000,
  slots             integer,
  registered_count  integer not null default 0,
  room_id           text references public.rooms (room_id) on delete set null,
  start_stack       integer,
  level_minutes     integer,
  features          jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

create index if not exists tournaments_date_idx on public.tournaments (date desc);
create index if not exists tournaments_room_idx on public.tournaments (room_id);
create unique index if not exists tournaments_room_uidx
  on public.tournaments (room_id) where room_id is not null;

-- ── Регистрации ────────────────────────────────────────────────────────────
create table if not exists public.registrations (
  id             bigserial primary key,
  tournament_id  bigint not null references public.tournaments (id) on delete cascade,
  player_id      bigint not null references public.players (id) on delete cascade,
  status         text not null default 'registered' check (status in ('registered', 'cancelled')),
  created_at     timestamptz not null default now(),
  unique (tournament_id, player_id)
);

create index if not exists registrations_tournament_idx on public.registrations (tournament_id);

-- ── Назначения операторов ──────────────────────────────────────────────────
create table if not exists public.tournament_operators (
  tournament_id  bigint not null references public.tournaments (id) on delete cascade,
  profile_id     uuid   not null references public.profiles (id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (tournament_id, profile_id)
);

create index if not exists tournament_operators_profile_idx
  on public.tournament_operators (profile_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Серверные функции
-- ═══════════════════════════════════════════════════════════════════════════

-- Часы сервера в миллисекундах. Админка и дисплей считают остаток уровня
-- своими часами; сбитые на десятки секунд часы ТВ искажают таймер, поэтому
-- обе страницы правят локальное время по этому значению (см. js/config.js).
create or replace function public.server_time_ms()
returns bigint
language sql
stable
as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint;
$$;

-- Аренда ведущего. Берётся, если свободна или протухла; держатель продлевает
-- её своим же вызовом. Возвращает победителя — клиент сравнивает с собой.
create or replace function public.try_acquire_room_lock(
  p_room_id     text,
  p_owner       text,
  p_ttl_seconds integer default 6
)
returns table (lock_owner text, lock_expires_at timestamptz)
language sql
security definer
set search_path = public
as $$
  with upd as (
    update public.rooms r
       set lock_owner      = p_owner,
           lock_expires_at = now() + make_interval(secs => greatest(p_ttl_seconds, 1))
     where r.room_id = p_room_id
       and (r.lock_owner is null or r.lock_owner = p_owner or r.lock_expires_at < now())
    returning r.lock_owner, r.lock_expires_at
  )
  -- Взяли аренду — возвращаем себя; не взяли — текущего держателя,
  -- клиент сравнит его с собой и поймёт, что он наблюдатель.
  select u.lock_owner, u.lock_expires_at from upd u
  union all
  select r.lock_owner, r.lock_expires_at
    from public.rooms r
   where r.room_id = p_room_id and not exists (select 1 from upd)
  limit 1;
$$;

-- Счётчик записавшихся держим в самом турнире: списки тянут и мини-апп, и
-- админка, а считать count(*) на каждый показ расписания незачем.
create or replace function public.sync_registered_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids bigint[];
  v_tid bigint;
begin
  -- В DELETE-триггере NEW не назначен, в UPDATE регистрацию могли перенести
  -- на другой турнир — поэтому собираем обе стороны и пересчитываем каждую.
  if tg_op <> 'INSERT' then v_ids := array_append(v_ids, old.tournament_id); end if;
  if tg_op <> 'DELETE' then v_ids := array_append(v_ids, new.tournament_id); end if;

  foreach v_tid in array coalesce(v_ids, '{}'::bigint[]) loop
    update public.tournaments t
       set registered_count = (
             select count(*) from public.registrations r
              where r.tournament_id = v_tid and r.status = 'registered')
     where t.id = v_tid;
  end loop;

  return null;   -- after-триггер, возвращаемое значение игнорируется
end;
$$;

drop trigger if exists registrations_sync_count on public.registrations;
create trigger registrations_sync_count
  after insert or update or delete on public.registrations
  for each row execute function public.sync_registered_count();

-- Новая регистрация доезжает в открытую комнату сама: оператор не должен
-- переимпортировать список из-за одного опоздавшего. Игрок добавляется
-- неотмеченным (present=false) — «пришёл» ставит оператор за столом.
-- Совпадение ищем по player_id и по свёрнутому имени, чтобы не задвоить того,
-- кого уже вписали руками.
create or replace function public.sync_registration_to_room()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room   text;
  v_name   text;
  v_key    text;
  v_state  jsonb;
  v_exists boolean;
begin
  if new.status <> 'registered' then
    return new;
  end if;

  select t.room_id into v_room from public.tournaments t where t.id = new.tournament_id;
  if v_room is null then
    return new;
  end if;

  select p.name, p.name_key into v_name, v_key from public.players p where p.id = new.player_id;
  if v_name is null then
    return new;
  end if;

  select r.state into v_state from public.rooms r where r.room_id = v_room for update;
  if v_state is null then
    return new;
  end if;

  select exists (
    select 1
      from jsonb_array_elements(coalesce(v_state -> 'players', '[]'::jsonb)) as pl
     where (pl ->> 'player_id')::bigint is not distinct from new.player_id
        or regexp_replace(lower(translate(coalesce(pl ->> 'name', ''), 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g') = v_key
  ) into v_exists;

  if v_exists then
    return new;
  end if;

  update public.rooms r
     set state = jsonb_set(
           v_state,
           '{players}',
           coalesce(v_state -> 'players', '[]'::jsonb) || jsonb_build_object(
             'name', v_name,
             'player_id', new.player_id,
             'present', false,
             'reentries', 0,
             'status', 'registered',
             'ko', 0,
             'koPts', 0
           )
         )
   where r.room_id = v_room;

  return new;
end;
$$;

drop trigger if exists registrations_sync_room on public.registrations;
create trigger registrations_sync_room
  after insert on public.registrations
  for each row execute function public.sync_registration_to_room();

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS
-- Админка уже прячет лишнее, но это только интерфейс: права раздаёт база.
-- ═══════════════════════════════════════════════════════════════════════════

-- Хелперы отдельными security definer функциями: политика, которая сама читает
-- profiles, упирается в RLS этой же profiles и уходит в рекурсию.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- Комната доступна админу всегда, оператору — если он назначен на турнир,
-- который к этой комнате привязан.
create or replace function public.can_access_room(p_room_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1
      from public.tournament_operators o
      join public.tournaments t on t.id = o.tournament_id
     where o.profile_id = auth.uid() and t.room_id = p_room_id
  );
$$;

create or replace function public.can_access_tournament(p_tournament_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.tournament_operators o
     where o.profile_id = auth.uid() and o.tournament_id = p_tournament_id
  );
$$;

alter table public.profiles             enable row level security;
alter table public.players              enable row level security;
alter table public.rooms                enable row level security;
alter table public.tournaments          enable row level security;
alter table public.registrations        enable row level security;
alter table public.tournament_operators enable row level security;

-- profiles: свой профиль видит каждый, все — только админ. Роль меняется
-- вручную в дашборде: дать пользователю право менять себе role значит дать
-- ему право стать админом.
drop policy if exists profiles_select_self  on public.profiles;
drop policy if exists profiles_select_admin on public.profiles;
drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_select_self  on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_select_admin on public.profiles for select to authenticated using (public.is_admin());
create policy profiles_update_admin on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- rooms: читает кто угодно — дисплей на ТВ работает без логина, по ссылке.
-- Пишет админ и назначенный оператор.
drop policy if exists rooms_select_all    on public.rooms;
drop policy if exists rooms_update_access on public.rooms;
drop policy if exists rooms_insert_admin  on public.rooms;
drop policy if exists rooms_delete_admin  on public.rooms;
create policy rooms_select_all    on public.rooms for select to anon, authenticated using (true);
create policy rooms_update_access on public.rooms for update to authenticated
  using (public.can_access_room(room_id)) with check (public.can_access_room(room_id));
create policy rooms_insert_admin  on public.rooms for insert to authenticated with check (public.is_admin());
create policy rooms_delete_admin  on public.rooms for delete to authenticated using (public.is_admin());

-- tournaments: расписание публичное (мини-апп показывает его до входа),
-- черновики и отменённые — только своим.
drop policy if exists tournaments_select_public on public.tournaments;
drop policy if exists tournaments_select_staff  on public.tournaments;
drop policy if exists tournaments_write_admin   on public.tournaments;
drop policy if exists tournaments_update_access on public.tournaments;
create policy tournaments_select_public on public.tournaments for select to anon, authenticated
  using (status in ('open', 'running', 'past'));
create policy tournaments_select_staff  on public.tournaments for select to authenticated
  using (public.is_admin() or public.can_access_tournament(id));
create policy tournaments_write_admin   on public.tournaments for insert to authenticated with check (public.is_admin());
create policy tournaments_update_access on public.tournaments for update to authenticated
  using (public.is_admin() or public.can_access_tournament(id))
  with check (public.is_admin() or public.can_access_tournament(id));

-- players и registrations: персональные данные, наружу не отдаём.
-- Запись через мини-апп пойдёт позже отдельной edge-функцией под service_role,
-- поэтому политик для anon здесь намеренно нет.
drop policy if exists players_select_staff on public.players;
drop policy if exists players_write_staff  on public.players;
create policy players_select_staff on public.players for select to authenticated using (auth.uid() is not null);
create policy players_write_staff  on public.players for insert to authenticated with check (auth.uid() is not null);

drop policy if exists registrations_select_access on public.registrations;
drop policy if exists registrations_write_access  on public.registrations;
drop policy if exists registrations_update_access on public.registrations;
create policy registrations_select_access on public.registrations for select to authenticated
  using (public.can_access_tournament(tournament_id));
create policy registrations_write_access  on public.registrations for insert to authenticated
  with check (public.can_access_tournament(tournament_id));
create policy registrations_update_access on public.registrations for update to authenticated
  using (public.can_access_tournament(tournament_id))
  with check (public.can_access_tournament(tournament_id));

-- tournament_operators: оператор видит только свои назначения — по ним админка
-- строит список доступных комнат. Раздаёт назначения только админ.
drop policy if exists operators_select_self  on public.tournament_operators;
drop policy if exists operators_select_admin on public.tournament_operators;
drop policy if exists operators_write_admin  on public.tournament_operators;
drop policy if exists operators_delete_admin on public.tournament_operators;
create policy operators_select_self  on public.tournament_operators for select to authenticated
  using (profile_id = auth.uid());
create policy operators_select_admin on public.tournament_operators for select to authenticated
  using (public.is_admin());
create policy operators_write_admin  on public.tournament_operators for insert to authenticated
  with check (public.is_admin());
create policy operators_delete_admin on public.tournament_operators for delete to authenticated
  using (public.is_admin());

-- ── Гранты и realtime ──────────────────────────────────────────────────────
grant usage on schema public to anon, authenticated;
grant select on public.rooms, public.tournaments to anon, authenticated;
grant select, insert, update, delete on
  public.players, public.registrations, public.tournaments,
  public.tournament_operators, public.profiles to authenticated;
grant update on public.rooms to authenticated;
grant insert, delete on public.rooms to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant execute on function public.server_time_ms() to anon, authenticated;
grant execute on function public.try_acquire_room_lock(text, text, integer) to authenticated;

-- Дисплей слушает UPDATE по своей комнате.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
     ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
end;
$$;
