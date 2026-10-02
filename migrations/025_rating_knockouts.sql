-- ═══════════════════════════════════════════════════════════════════════════
-- Нокауты в рейтинге.
--
-- vp_app_rating отдаёт ещё и ko — сумму нокаутов игрока за период, чтобы
-- вкладка «Рейтинг» показывала их рядом с турнирами и победами. Остальное
-- как в 019. Тип результата меняется, поэтому функцию пересоздаём.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.vp_app_rating(text);

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
  )
  select t.player_id, t.name, t.points, t.games, t.wins, rank() over (order by t.points desc), t.photo_url,
         lv.level, lv.rank_key, t.ko
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
