-- Аватарки игроков (photo_url уже есть в players из TG/VK-логина) наружу:
-- в рейтинге и в составе турнира их раньше не отдавали.
-- create or replace не меняет состав OUT-колонок — функции пересоздаём.
drop function if exists public.vp_app_rating(text);
drop function if exists public.vp_tournament_roster(bigint);

create or replace function public.vp_app_rating(p_period text default 'month')
returns table (player_id bigint, name text, points bigint, games bigint, wins bigint, rank bigint, photo_url text)
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
  select player_id, name, points, games, wins, rank() over (order by points desc), photo_url
    from totals order by points desc, name, player_id;
$$;
revoke all on function public.vp_app_rating(text) from public;
grant execute on function public.vp_app_rating(text) to anon, authenticated;

create or replace function public.vp_tournament_roster(p_tournament_id bigint)
returns table (player_id bigint, name text, registered_at timestamptz, photo_url text)
language sql
stable
security definer
set search_path = public
as $$
  select r.player_id, p.name, r.created_at, p.photo_url
    from public.registrations r
    join public.players p on p.id = r.player_id
    join public.tournaments t on t.id = r.tournament_id
   where r.tournament_id = p_tournament_id
     and r.status = 'registered'
     and t.status in ('open', 'running', 'past')
   order by r.created_at;
$$;
grant execute on function public.vp_tournament_roster(bigint) to anon, authenticated;
