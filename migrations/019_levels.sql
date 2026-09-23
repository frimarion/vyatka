-- Уровни игроков: опыт (XP) за то, что человек ходит в клуб.
--
-- Рейтинг меряет силу игры и обнуляется каждый месяц, уровень — верность
-- клубу: растёт от каждого визита и никогда не падает. Опыт не хранится
-- счётчиком, а считается из снимков итогов (tournament_result_players):
-- админка пересохраняет отчёт, удаляя и вставляя строки игроков заново, и
-- счётчик задваивался бы на каждом «Сохранить». Заодно уровни сразу есть у
-- всех по уже сыгранной истории, а vp_merge_players ничего переносить не надо.
--
-- Учитываются те же итоги, что и в рейтинге (013): турнир прошёл (status
-- 'past') или итог без турнира, у всех строк есть место. За ре-энтри и
-- аддоны опыт не даётся — уровень не покупается.
--
-- За что начисляется (правила дублирует лист «Как получить опыт» в index.html):
--   сыграл турнир .................................. +100
--   первый турнир в клубе (разово) ................. +150
--   записался заранее в приложении и пришёл ........ +20
--   нокаут ......................................... +10 за каждый
--   1 / 2 / 3 место ................................ +150 / +100 / +75
--   остальные призовые места (очки > 0) ............ +40
--   четвёртый турнир за календарный месяц (МСК) .... +200
--   заполнены ФИО и телефон (разово) ............... +100

-- ── Пороги уровней ──────────────────────────────────────────────────────────
-- 25 уровней, пять рангов по пять. Темп меняется update'ом этой таблицы —
-- коду нужны только level и rank_key.
create table if not exists public.vp_levels (
  level      integer primary key check (level >= 1),
  xp_from    integer not null unique check (xp_from >= 0),
  rank_key   text not null check (rank_key in ('novice', 'habitue', 'regular', 'shark', 'legend')),
  rank_name  text not null
);

insert into public.vp_levels (level, xp_from, rank_key, rank_name) values
  ( 1,     0, 'novice',  'Новичок'),
  ( 2,   200, 'novice',  'Новичок'),
  ( 3,   450, 'novice',  'Новичок'),
  ( 4,   750, 'novice',  'Новичок'),
  ( 5,  1100, 'novice',  'Новичок'),
  ( 6,  1500, 'habitue', 'Завсегдатай'),
  ( 7,  2000, 'habitue', 'Завсегдатай'),
  ( 8,  2600, 'habitue', 'Завсегдатай'),
  ( 9,  3300, 'habitue', 'Завсегдатай'),
  (10,  4100, 'habitue', 'Завсегдатай'),
  (11,  5000, 'regular', 'Регуляр'),
  (12,  6000, 'regular', 'Регуляр'),
  (13,  7100, 'regular', 'Регуляр'),
  (14,  8300, 'regular', 'Регуляр'),
  (15,  9600, 'regular', 'Регуляр'),
  (16, 11000, 'shark',   'Акула'),
  (17, 12500, 'shark',   'Акула'),
  (18, 14100, 'shark',   'Акула'),
  (19, 15800, 'shark',   'Акула'),
  (20, 17600, 'shark',   'Акула'),
  (21, 19500, 'legend',  'Легенда клуба'),
  (22, 21500, 'legend',  'Легенда клуба'),
  (23, 23600, 'legend',  'Легенда клуба'),
  (24, 25800, 'legend',  'Легенда клуба'),
  (25, 28000, 'legend',  'Легенда клуба')
on conflict (level) do nothing;

-- Таблица справочная: читать можно всем, писать — только миграцией.
alter table public.vp_levels enable row level security;
drop policy if exists vp_levels_read on public.vp_levels;
create policy vp_levels_read on public.vp_levels for select using (true);
revoke insert, update, delete, truncate on public.vp_levels from anon, authenticated;
grant select on public.vp_levels to anon, authenticated;

-- ── Сыгранные турниры ───────────────────────────────────────────────────────
-- Одна строка на игрока и итог. Игрока без player_id (вписали руками)
-- подбираем по свёрнутому имени — как рейтинг и история. name_key у players
-- уникален, так что подбор однозначный; distinct on — на случай, когда в
-- одном итоге человек оказался и строкой с id, и строкой по имени.
create or replace view public.vp_xp_games as
select distinct on (p.id, tr.id)
       p.id as player_id, tr.id as result_id, tr.tournament_id, tr.name as title,
       tr.played_at, trp.place, trp.ko, trp.points
  from public.tournament_result_players trp
  join public.tournament_results tr on tr.id = trp.result_id
  join public.players p on p.id = coalesce(trp.player_id,
         (select pl.id from public.players pl where pl.name_key = trp.name_key))
 where tr.played_at <= now()
   and (tr.tournament_id is null or exists (
         select 1 from public.tournaments t where t.id = tr.tournament_id and t.status = 'past'))
   and not exists (select 1 from public.tournament_result_players r
                    where r.result_id = tr.id and (r.place is null or r.place < 1))
 order by p.id, tr.id, trp.player_id nulls last;

-- ── Журнал начислений ───────────────────────────────────────────────────────
-- grp склеивает строки одного события для ленты в профиле: всё за турнир —
-- 'r<result_id>', бонус за месяц — 'm<YYYY-MM>', профиль — 'profile'.
-- n — количество (нокаутов, место), чтобы лента написала «3 нокаута».
create or replace view public.vp_xp_ledger as
with g as (
  select g.*,
         row_number() over (partition by g.player_id order by g.played_at, g.result_id) as nth,
         row_number() over (
           partition by g.player_id, date_trunc('month', g.played_at at time zone 'Europe/Moscow')
           order by g.played_at, g.result_id) as nth_in_month
    from public.vp_xp_games g
)
select g.player_id, 'r' || g.result_id as grp, g.played_at as at, 'game'::text as kind,
       g.title, 100 as xp, 1 as n
  from g
union all
select g.player_id, 'r' || g.result_id, g.played_at, 'first', g.title, 150, 1
  from g where g.nth = 1
union all
-- «Заранее» — до начала турнира; у турнира без даты — до сохранения итога.
select g.player_id, 'r' || g.result_id, g.played_at, 'prereg', g.title, 20, 1
  from g
  join public.tournaments t on t.id = g.tournament_id
  join public.registrations r on r.tournament_id = g.tournament_id
                             and r.player_id = g.player_id and r.status = 'registered'
 where r.created_at < coalesce(t.date, g.played_at)
union all
select g.player_id, 'r' || g.result_id, g.played_at, 'ko', g.title, 10 * g.ko, g.ko
  from g where g.ko > 0
union all
select g.player_id, 'r' || g.result_id, g.played_at, 'place', g.title,
       case g.place when 1 then 150 when 2 then 100 when 3 then 75 else 40 end, g.place
  from g where g.place between 1 and 3 or g.points > 0
union all
select g.player_id, 'm' || to_char(g.played_at at time zone 'Europe/Moscow', 'YYYY-MM'), g.played_at,
       'month', to_char(g.played_at at time zone 'Europe/Moscow', 'YYYY-MM'), 200, 4
  from g where g.nth_in_month = 4
union all
select p.id, 'profile', p.created_at, 'profile', null, 100, 1
  from public.players p
 where nullif(btrim(p.full_name), '') is not null and nullif(btrim(p.phone), '') is not null;

create or replace view public.vp_xp_totals as
select player_id, sum(xp)::bigint as xp, count(*) filter (where kind = 'game') as games
  from public.vp_xp_ledger group by player_id;

-- Вьюхи выполняются с правами владельца и обходят RLS итогов — наружу их не
-- отдаём, приложение получает опыт только через функции ниже.
revoke all on public.vp_xp_games, public.vp_xp_ledger, public.vp_xp_totals from public, anon, authenticated;

-- ── Уровень по опыту ────────────────────────────────────────────────────────
-- xp_next пуст на последнем уровне.
create or replace function public.vp_level_json(p_xp bigint)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'xp', greatest(coalesce(p_xp, 0), 0),
    'level', l.level,
    'rank_key', l.rank_key,
    'rank_name', l.rank_name,
    'xp_from', l.xp_from,
    'xp_next', (select min(n.xp_from) from public.vp_levels n where n.level > l.level))
    from public.vp_levels l
   where l.xp_from <= greatest(coalesce(p_xp, 0), 0)
   order by l.level desc
   limit 1;
$$;

create or replace function public.vp_player_level(p_player_id bigint)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select public.vp_level_json(coalesce(
    (select x.xp from public.vp_xp_totals x where x.player_id = p_player_id), 0));
$$;

revoke all on function public.vp_level_json(bigint) from public;
revoke all on function public.vp_player_level(bigint) from public;

-- ── Свой профиль: опыт и лента начислений ───────────────────────────────────
-- Остальное — как в 018.
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
          select tr.name, tr.played_at, trp.place, trp.ko, trp.points, trp.entries,
                 tr.tournament_id, t.card_art
            from public.tournament_result_players trp
            join public.tournament_results tr on tr.id = trp.result_id
            left join public.tournaments t on t.id = tr.tournament_id
           where trp.player_id = v_id or (trp.player_id is null and trp.name_key = v_key)
           order by tr.played_at desc
           limit 30
        ) h
    ), '[]'::json),
    'level', (public.vp_player_level(v_id)::jsonb || jsonb_build_object('events', coalesce((
      select jsonb_agg(e order by e.at desc)
        from (
          select l.grp, max(l.at) as at, max(l.title) as title, sum(l.xp) as xp,
                 jsonb_agg(jsonb_build_object('kind', l.kind, 'xp', l.xp, 'n', l.n)
                   order by array_position(array['game', 'first', 'prereg', 'place', 'ko', 'month', 'profile'], l.kind)) as parts
            from public.vp_xp_ledger l
           where l.player_id = v_id
           group by l.grp
           order by max(l.at) desc
           limit 20
        ) e
    ), '[]'::jsonb)))::json
  );
end;
$$;

-- ── Чужой профиль: уровень без ленты ────────────────────────────────────────
create or replace function public.vp_app_player_public(p_player_id bigint)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_name text;
  v_photo text;
  v_key text;
begin
  select name, photo_url, name_key into v_name, v_photo, v_key
    from public.players where id = p_player_id;
  if not found then
    raise exception 'player_not_found';
  end if;

  return (
    with h as (
      select tr.name, tr.played_at, trp.place, trp.ko, trp.points, trp.entries,
             tr.tournament_id, t.card_art
        from public.tournament_result_players trp
        join public.tournament_results tr on tr.id = trp.result_id
        left join public.tournaments t on t.id = tr.tournament_id
       where trp.player_id = p_player_id
          or (trp.player_id is null and trp.name_key = v_key)
    )
    select json_build_object(
      'player', json_build_object('id', p_player_id, 'name', v_name, 'photo_url', v_photo),
      -- Статистика — по всей истории, а список — последние 30, как в своём профиле.
      'stats', (select json_build_object(
          'games', count(*),
          'wins',  count(*) filter (where place = 1),
          'top3',  count(*) filter (where place between 1 and 3),
          'ko',    coalesce(sum(ko), 0))
        from h),
      'history', coalesce((
        select json_agg(x order by x.played_at desc)
          from (select * from h order by played_at desc limit 30) x
      ), '[]'::json),
      'level', public.vp_player_level(p_player_id)
    )
  );
end;
$$;

-- ── Списки: уровень рядом с аватаркой ───────────────────────────────────────
-- create or replace не меняет состав OUT-колонок — пересоздаём (как в 013).
-- Строка без игрока в базе (вписан руками, профиля нет) — без уровня.
drop function if exists public.vp_app_rating(text);
drop function if exists public.vp_tournament_roster(bigint);
drop function if exists public.vp_tournament_results(bigint);

create or replace function public.vp_app_rating(p_period text default 'month')
returns table (player_id bigint, name text, points bigint, games bigint, wins bigint, rank bigint,
               photo_url text, level integer, rank_key text)
language sql stable security definer set search_path = public
as $$
  with period as (
    select case
      when p_period = 'month' then date_trunc('month', now() at time zone 'Europe/Moscow')
      when p_period = 'year' then date_trunc('year', now() at time zone 'Europe/Moscow')
      when p_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and left(p_period, 4) <> '0000'
        then to_date(p_period || '-01', 'YYYY-MM-DD')::timestamp
    end as starts
  ), eligible as (
    select tr.id from public.tournament_results tr cross join period p
    where (p_period = 'all' or (
      tr.played_at >= (p.starts at time zone 'Europe/Moscow')
      and tr.played_at < ((p.starts + case when p_period = 'year'
        then interval '1 year' else interval '1 month' end) at time zone 'Europe/Moscow')))
      and tr.played_at <= now()
      and (tr.tournament_id is null or exists (
        select 1 from public.tournaments t where t.id = tr.tournament_id and t.status = 'past'))
      and exists (select 1 from public.tournament_result_players r where r.result_id = tr.id)
      and not exists (select 1 from public.tournament_result_players r
        where r.result_id = tr.id and (r.place is null or r.place < 1))
  ), totals as (
    select p.id as player_id, coalesce(p.name, max(r.name)) as name,
      sum(r.points)::bigint as points, count(distinct r.result_id) as games,
      count(*) filter (where r.place = 1) as wins, max(p.photo_url) as photo_url
    from public.tournament_result_players r join eligible e on e.id = r.result_id
    left join public.players p on p.id = r.player_id or (r.player_id is null and p.name_key = r.name_key)
    group by p.id, case when p.id is null then r.name_key end
  )
  select t.player_id, t.name, t.points, t.games, t.wins, rank() over (order by t.points desc), t.photo_url,
         lv.level, lv.rank_key
    from totals t
    left join public.vp_xp_totals x on x.player_id = t.player_id
    left join lateral (
      select l.level, l.rank_key from public.vp_levels l
       where t.player_id is not null and l.xp_from <= coalesce(x.xp, 0)
       order by l.level desc limit 1
    ) lv on true
   order by t.points desc, t.name, t.player_id;
$$;
revoke all on function public.vp_app_rating(text) from public;
grant execute on function public.vp_app_rating(text) to anon, authenticated;

create or replace function public.vp_tournament_roster(p_tournament_id bigint)
returns table (player_id bigint, name text, registered_at timestamptz, photo_url text,
               level integer, rank_key text)
language sql
stable
security definer
set search_path = public
as $$
  select r.player_id, p.name, r.created_at, p.photo_url, lv.level, lv.rank_key
    from public.registrations r
    join public.players p on p.id = r.player_id
    join public.tournaments t on t.id = r.tournament_id
    left join public.vp_xp_totals x on x.player_id = p.id
    left join lateral (
      select l.level, l.rank_key from public.vp_levels l
       where l.xp_from <= coalesce(x.xp, 0) order by l.level desc limit 1
    ) lv on true
   where r.tournament_id = p_tournament_id
     and r.status = 'registered'
     and t.status in ('open', 'running', 'past')
   order by r.created_at;
$$;
grant execute on function public.vp_tournament_roster(bigint) to anon, authenticated;

create or replace function public.vp_tournament_results(p_tournament_id bigint)
returns table (place integer, name text, ko integer, points integer, player_id bigint, photo_url text,
               level integer, rank_key text)
language sql
stable
security definer
set search_path = public
as $$
  select trp.place, trp.name, trp.ko, trp.points, p.id, p.photo_url, lv.level, lv.rank_key
    from public.tournament_result_players trp
    join public.tournament_results tr on tr.id = trp.result_id
    left join lateral (
      select pl.id, pl.photo_url from public.players pl
       where pl.id = trp.player_id
          or (trp.player_id is null and pl.name_key = trp.name_key)
       order by (pl.id = trp.player_id) desc nulls last
       limit 1
    ) p on true
    left join public.vp_xp_totals x on x.player_id = p.id
    left join lateral (
      select l.level, l.rank_key from public.vp_levels l
       where p.id is not null and l.xp_from <= coalesce(x.xp, 0)
       order by l.level desc limit 1
    ) lv on true
   where tr.tournament_id = p_tournament_id
     and exists (select 1 from public.tournaments t
                  where t.id = p_tournament_id and t.status = 'past')
   order by (trp.place is null), trp.place;
$$;
revoke all on function public.vp_tournament_results(bigint) from public;
grant execute on function public.vp_tournament_results(bigint) to anon, authenticated;

-- ── Админка: уровни игроков вечера ──────────────────────────────────────────
-- Крупье видит, кто пришёл впервые или ещё новичок. games — сколько турниров
-- уже засчитано: 0 значит «первый визит».
create or replace function public.vp_levels_for(p_ids bigint[])
returns table (player_id bigint, xp bigint, games bigint, level integer, rank_key text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, coalesce(x.xp, 0), coalesce(x.games, 0), lv.level, lv.rank_key
    from public.players p
    left join public.vp_xp_totals x on x.player_id = p.id
    left join lateral (
      select l.level, l.rank_key from public.vp_levels l
       where l.xp_from <= coalesce(x.xp, 0) order by l.level desc limit 1
    ) lv on true
   where p.id = any(p_ids) and public.is_staff();
$$;
revoke all on function public.vp_levels_for(bigint[]) from public, anon;
grant execute on function public.vp_levels_for(bigint[]) to authenticated;

notify pgrst, 'reload schema';
