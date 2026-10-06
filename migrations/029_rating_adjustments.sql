-- ═══════════════════════════════════════════════════════════════════════════
-- Доп. очки рейтинга: админ доначисляет игроку очки сверх мест и нокаутов.
--
-- Бонус лежит в отдельной таблице, а не в tournament_result_players.points:
-- снимок турнира перезаписывается при каждом пересохранении вечера, и ручное
-- начисление пропало бы вместе со старой строкой. К тому же в points лежат
-- только очки за место, и по ним считается опыт — бонус на ХР и уровни
-- не влияет (vp_xp_* читают снимки, эту таблицу не трогают).
--
-- Бонус бывает привязан к сыгранному турниру (result_id) или начислен «просто
-- так» (result_id is null). В обоих случаях период определяет awarded_at:
-- для привязанного приложение кладёт туда дату турнира, и очки попадают в тот
-- же месяц, что и сам вечер. Только положительные очки.
--
-- Применять после 028. Идемпотентно.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.rating_adjustments (
  id          bigserial primary key,
  player_id   bigint not null references public.players (id) on delete cascade,
  result_id   bigint references public.tournament_results (id) on delete set null,
  points      integer not null check (points > 0 and points <= 100000),
  reason      text not null default '' check (char_length(reason) <= 200),
  awarded_at  timestamptz not null default now(),
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists rating_adjustments_player_idx on public.rating_adjustments (player_id);
create index if not exists rating_adjustments_awarded_idx on public.rating_adjustments (awarded_at desc);
create index if not exists rating_adjustments_result_idx on public.rating_adjustments (result_id);

-- Видит и меняет только админ: оператор ведёт вечер, но очки не раздаёт.
-- Игрокам бонусы отдаёт vp_app_rating (security definer) — уже суммой.
alter table public.rating_adjustments enable row level security;

drop policy if exists rating_adjustments_admin on public.rating_adjustments;
create policy rating_adjustments_admin on public.rating_adjustments
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── Рейтинг ────────────────────────────────────────────────────────────────
-- Как в 026 плюс бонусы. games и wins бонус не трогает; игрок, у которого в
-- периоде только бонус, тоже попадает в таблицу.
create or replace function public.vp_app_rating(p_period text default 'month')
returns table (player_id bigint, name text, points bigint, games bigint, wins bigint, rank bigint,
               photo_url text, level integer, rank_key text, ko bigint)
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
      count(*) filter (where r.place = 1) as wins, max(p.photo_url) as photo_url,
      coalesce(sum(r.ko), 0)::bigint as ko
    from public.tournament_result_players r join eligible e on e.id = r.result_id
    left join public.players p on p.id = r.player_id or (r.player_id is null and p.name_key = r.name_key)
    group by p.id, case when p.id is null then r.name_key end
  ), bonus as (
    select a.player_id, sum(a.points)::bigint as points
    from public.rating_adjustments a cross join period p
    where (p_period = 'all' or (
      a.awarded_at >= (p.starts at time zone 'Europe/Moscow')
      and a.awarded_at < ((p.starts + case when p_period = 'year'
        then interval '1 year' else interval '1 month' end) at time zone 'Europe/Moscow')))
      and a.awarded_at <= now()
    group by a.player_id
  ), combined as (
    select t.player_id, t.name, t.points + coalesce(b.points, 0) as points, t.games, t.wins, t.photo_url, t.ko
      from totals t left join bonus b on b.player_id = t.player_id
    union all
    select p.id, p.name, b.points, 0::bigint, 0::bigint, p.photo_url, 0::bigint
      from bonus b join public.players p on p.id = b.player_id
     where not exists (select 1 from totals t where t.player_id = b.player_id)
  )
  select t.player_id, t.name, t.points, t.games, t.wins, case when t.points > 0 then rank() over (order by t.points desc)
           else row_number() over (order by t.points desc, t.name, t.player_id) end, t.photo_url,
         lv.level, lv.rank_key, t.ko
    from combined t
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

-- ── Склейка аккаунтов ──────────────────────────────────────────────────────
-- Как в 006, плюс перенос бонусов: без него delete игрока-донора каскадом
-- стёр бы начисленные ему очки.
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

  -- Сыгранные вечера и доп. очки переезжают целиком, дублей там быть не может.
  update public.tournament_result_players set player_id = p_keep where player_id = p_remove;
  update public.rating_adjustments set player_id = p_keep where player_id = p_remove;

  delete from public.players where id = p_remove;

  return public.vp_player_json(p_keep);
end;
$fn$;

notify pgrst, 'reload schema';
