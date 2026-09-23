-- Сыгранное в профиле показывает карточку турнира с картинкой («Джокер»,
-- «Нокаут», «Феникс» — migrations/017), поэтому истории нужны tournament_id
-- и card_art. left join: итог без привязки к турниру (или турнир удалили)
-- остаётся в истории обычной строкой. Остальное — как было (005 и 016).

-- Четвёртое оформление — «Double Life» (assets/art/doublelife.webp).
alter table public.tournaments drop constraint if exists tournaments_card_art_check;
alter table public.tournaments add constraint tournaments_card_art_check
  check (card_art is null or card_art in ('joker', 'knockout', 'phoenix', 'doublelife'));

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
    ), '[]'::json)
  );
end;
$$;

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
      ), '[]'::json)
    )
  );
end;
$$;

-- PostgREST кэширует схему: новые поля в ответе функций видны и так, но
-- сменившийся check — только после перезагрузки.
notify pgrst, 'reload schema';
