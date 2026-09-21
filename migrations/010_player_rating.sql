-- Публичный рейтинг: только игровые показатели из завершённых снимков.
create or replace function public.vp_app_rating(p_period text default 'month')
returns table (player_id bigint, name text, points bigint, games bigint, wins bigint, rank bigint)
language sql stable security definer set search_path = public
as $$
  with eligible as (
    select tr.id from public.tournament_results tr
    where p_period in ('month', 'year', 'all')
      and (p_period = 'all' or tr.played_at >=
        (date_trunc(case when p_period = 'year' then 'year' else 'month' end,
          now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow'))
      and tr.played_at <= now()
      and (tr.tournament_id is null or exists (
        select 1 from public.tournaments t where t.id = tr.tournament_id and t.status = 'past'))
      and exists (select 1 from public.tournament_result_players r where r.result_id = tr.id)
      and not exists (select 1 from public.tournament_result_players r
        where r.result_id = tr.id and (r.place is null or r.place < 1))
  ), totals as (
    select p.id as player_id, coalesce(p.name, max(r.name)) as name,
      sum(r.points)::bigint as points, count(distinct r.result_id) as games,
      count(*) filter (where r.place = 1) as wins
    from public.tournament_result_players r join eligible e on e.id = r.result_id
    left join public.players p on p.id = r.player_id or (r.player_id is null and p.name_key = r.name_key)
    group by p.id, case when p.id is null then r.name_key end
  )
  select player_id, name, points, games, wins, rank() over (order by points desc)
    from totals order by points desc, name, player_id;
$$;
revoke all on function public.vp_app_rating(text) from public;
grant execute on function public.vp_app_rating(text) to anon, authenticated;
