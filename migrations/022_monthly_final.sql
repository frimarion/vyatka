-- ═══════════════════════════════════════════════════════════════════════════
-- Финал месяца.
--
-- Флаг на турнире. Такой турнир в приложении виден, но записаться на него
-- самому нельзя: состав собирает админ руками в tournaments.html (прямой
-- upsert в registrations под can_access_tournament — эта функция его не
-- касается). Сняться игрок может, как и с любого турнира.
--
-- Запрет — здесь, в vp_app_register, а не только в интерфейсе: старая
-- вкладка приложения или прямой вызов RPC иначе прошли бы мимо кнопки.
-- Остальное тело функции — без изменений против 005_player_app.sql.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.tournaments
  add column if not exists is_monthly_final boolean not null default false;

create or replace function public.vp_app_register(p_token text, p_tournament_id bigint)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id      bigint := public.vp_session_player(p_token);
  v_slots   integer;
  v_status  text;
  v_final   boolean;
  v_taken   integer;
  v_count   integer;
begin
  select t.slots, t.status, t.is_monthly_final into v_slots, v_status, v_final
    from public.tournaments t where t.id = p_tournament_id
     for update;
  if v_status is null then
    raise exception 'tournament_not_found';
  end if;
  if v_final then
    raise exception 'final_invite_only';
  end if;
  if v_status not in ('open', 'running') then
    raise exception 'registration_closed';
  end if;

  if v_slots is not null then
    select count(*) into v_taken
      from public.registrations
     where tournament_id = p_tournament_id and status = 'registered';
    if v_taken >= v_slots and not exists (
      select 1 from public.registrations
       where tournament_id = p_tournament_id and player_id = v_id and status = 'registered'
    ) then
      raise exception 'tournament_full';
    end if;
  end if;

  insert into public.registrations (tournament_id, player_id, status)
  values (p_tournament_id, v_id, 'registered')
  on conflict (tournament_id, player_id)
    do update set status = 'registered', created_at = now();

  select registered_count into v_count from public.tournaments where id = p_tournament_id;
  return json_build_object('registered', true, 'registered_count', coalesce(v_count, 0));
end;
$$;
