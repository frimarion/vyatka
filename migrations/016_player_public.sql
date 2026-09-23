-- Чужой профиль в приложении: из состава турнира, итогов и рейтинга можно
-- открыть игрока и посмотреть его статистику и сыгранное.
--
-- Наружу отдаётся только то, что и так публично видно в рейтинге и итогах:
-- ник, фото, места и ноки. Полное имя, телефон, почта и VK — нет.

-- Итогам нужен player_id, чтобы строку можно было открыть. Игрока, вписанного
-- руками без player_id, подбираем по свёрнутому имени — так же, как CRM и
-- vp_app_me. create or replace не меняет OUT-колонки — пересоздаём.
drop function if exists public.vp_tournament_results(bigint);

create or replace function public.vp_tournament_results(p_tournament_id bigint)
returns table (place integer, name text, ko integer, points integer, player_id bigint, photo_url text)
language sql
stable
security definer
set search_path = public
as $$
  select trp.place, trp.name, trp.ko, trp.points, p.id, p.photo_url
    from public.tournament_result_players trp
    join public.tournament_results tr on tr.id = trp.result_id
    left join lateral (
      select pl.id, pl.photo_url from public.players pl
       where pl.id = trp.player_id
          or (trp.player_id is null and pl.name_key = trp.name_key)
       order by (pl.id = trp.player_id) desc nulls last
       limit 1
    ) p on true
   where tr.tournament_id = p_tournament_id
     and exists (select 1 from public.tournaments t
                  where t.id = p_tournament_id and t.status = 'past')
   order by (trp.place is null), trp.place;
$$;
revoke all on function public.vp_tournament_results(bigint) from public;
grant execute on function public.vp_tournament_results(bigint) to anon, authenticated;

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
      select tr.name, tr.played_at, trp.place, trp.ko, trp.points, trp.entries
        from public.tournament_result_players trp
        join public.tournament_results tr on tr.id = trp.result_id
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
      ), '[]'::json)
    )
  );
end;
$$;
revoke all on function public.vp_app_player_public(bigint) from public;
grant execute on function public.vp_app_player_public(bigint) to anon, authenticated;
