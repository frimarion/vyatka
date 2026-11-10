-- Полная работа оператора в назначенной комнате; CRM остаётся закрытой.
begin;

create or replace function public.can_access_room(p_room_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or public.vp_operator_room_access(p_room_id);
$$;

create or replace function public.can_access_tournament(p_tournament_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.profiles p
    join public.tournament_operators o on o.profile_id = p.id
    where p.id = auth.uid() and p.role = 'operator' and o.tournament_id = p_tournament_id
  );
$$;

drop policy if exists rooms_select_all on public.rooms;
create policy rooms_select_all on public.rooms for select to anon, authenticated
  using (public.can_access_room(room_id));

-- Регистрации разрешены только своего турнира, даже при старых широких политиках.
drop policy if exists timer_only_admin on public.registrations;
drop policy if exists registrations_room_access on public.registrations;
create policy registrations_room_access on public.registrations as restrictive
  for all to authenticated using (public.can_access_tournament(tournament_id))
  with check (public.can_access_tournament(tournament_id));

-- Оператор не меняет привязку турнира к комнате и не назначает сам себя.
drop policy if exists tournaments_update_access on public.tournaments;
create policy tournaments_update_access on public.tournaments for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Справочник для посадки: имена/фото, без контактов, долгов и истории CRM.
-- Фото по id и загрузка регистраций ограничены текущей комнатой.
create or replace function public.vp_room_players(
  p_room_id text, p_patterns text[] default null,
  p_ids bigint[] default null, p_registrations boolean default false
)
returns table(id bigint, name text, full_name text, photo_url text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_access_room(p_room_id) then raise exception 'Нет доступа к комнате'; end if;
  return query
    select p.id, p.name, p.full_name, p.photo_url from public.players p
    where case
      when p_registrations then exists (
        select 1 from public.registrations r join public.tournaments t on t.id = r.tournament_id
        where t.room_id = p_room_id and r.player_id = p.id and r.status = 'registered'
      )
      when p_ids is not null then p.id = any(p_ids[1:500]) and (
        exists (select 1 from public.rooms rm,
          jsonb_array_elements(coalesce(rm.state->'players', '[]'::jsonb)) pl
          where rm.room_id = p_room_id and pl->>'player_id' = p.id::text)
        or exists (select 1 from public.registrations r join public.tournaments t on t.id = r.tournament_id
          where t.room_id = p_room_id and r.player_id = p.id and r.status = 'registered')
      )
      else exists (
        select 1 from unnest(p_patterns[1:5]) pat
        where length(pat) between 2 and 80
          and (p.name ilike '%' || pat || '%' or p.full_name ilike '%' || pat || '%')
      )
    end
    order by p.name, p.id limit case when p_registrations or p_ids is not null then 500 else 20 end;
end;
$$;

create or replace function public.vp_room_ensure_player(p_room_id text, p_name text)
returns table(id bigint, photo_url text)
language plpgsql security definer set search_path = public as $$
declare v_name text := regexp_replace(trim(p_name), '\s+', ' ', 'g');
begin
  if not public.can_access_room(p_room_id) then raise exception 'Нет доступа к комнате'; end if;
  if v_name is null or length(v_name) not between 1 and 80 then raise exception 'Некорректное имя'; end if;
  return query
    insert into public.players as p(name) values (v_name)
    on conflict (name_key) do update set name = p.name
    returning p.id, p.photo_url;
end;
$$;

revoke all on function public.vp_room_players(text,text[],bigint[],boolean),
  public.vp_room_ensure_player(text,text) from public, anon;
grant execute on function public.vp_room_players(text,text[],bigint[],boolean),
  public.vp_room_ensure_player(text,text) to authenticated;

-- Политики players/CRM из 038 не снимаем. Завершение своего турнира использует
-- проверенный vp_finish_tournament (security definer), без доступа к чужим отчётам.
notify pgrst, 'reload schema';
commit;
