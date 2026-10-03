-- ═══════════════════════════════════════════════════════════════════════════
-- Помощник записи: новый игрок прямо из приложения.
--
-- В 023 помощник мог записать только того, кто уже есть в базе. А в зал
-- приходят и новенькие — поиск их не находил, и записать их было нечем.
-- Админка (admin.html) такого принимает «как есть», без player_id; здесь
-- состав живёт в registrations, поэтому игрока заводим в players по имени.
--
-- Имя, совпавшее со свёрнутым name_key существующего игрока, нового не
-- создаёт — записывается тот, кто уже есть: под одним именем в клубе один
-- человек (см. players_name_key_uidx в 001).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.vp_app_helper_add_new(
  p_token text, p_tournament_id bigint, p_name text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id   bigint;
  v_res  json;
begin
  perform public._vp_helper(p_token);

  if length(v_name) < 2 or length(v_name) > 60 or v_name ~ '<[^>]+>' then
    raise exception 'invalid_name';
  end if;

  select id into v_id from public.players
   where name_key = regexp_replace(lower(translate(v_name, 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g');

  if v_id is null then
    insert into public.players (name) values (v_name)
    on conflict (name_key) do nothing
    returning id into v_id;
    -- Гонка с параллельной записью того же имени: берём того, кто успел.
    if v_id is null then
      select id into v_id from public.players
       where name_key = regexp_replace(lower(translate(v_name, 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g');
    end if;
  end if;

  -- Статус турнира и права проверяет 023 — второй раз не повторяем.
  v_res := public.vp_app_helper_set_reg(p_token, p_tournament_id, v_id, true);
  return json_build_object(
    'player_id', v_id,
    'name', (select name from public.players where id = v_id),
    'registered_count', v_res -> 'registered_count');
end;
$$;

revoke all on function public.vp_app_helper_add_new(text, bigint, text) from public;
grant execute on function public.vp_app_helper_add_new(text, bigint, text) to anon, authenticated;
