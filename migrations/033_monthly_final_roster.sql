-- ═══════════════════════════════════════════════════════════════════════════
-- Финал месяца по логике Дойла: состав считается из рейтинга, игроки
-- подтверждают участие сами.
--
-- Было (022): состав финала админ собирал руками в tournaments.html.
-- Стало:
--   • Состав — топ-N (N = slots турнира, по умолчанию 27) рейтинга месяца,
--     за который разыгрывается финал. Месяц — final_rating_month (YYYY-MM),
--     если пусто — месяц перед датой финала. При равенстве очков выше тот, у
--     кого больше нокаутов, дальше по имени — как в списке финалистов Дойла.
--   • Запись (registrations, status='registered') у финала значит «подтвердил
--     участие». Подтвердившие доезжают в комнату таймера тем же триггером.
--   • «Не смогу» не выкидывает игрока сразу: отказ ждёт решения админа
--     (final_declines.status='pending'). Админ подтверждает отказ — игрок
--     исключён (status='approved'), его место занимает следующий по рейтингу.
--   • Пока рейтинг месяца ещё может поменяться, состав предварительный:
--     final_confirmations_open=false, игроки не подтверждают и не отказываются.
--     Админ открывает подтверждения, когда состав окончательный.
--   • Админ может подтвердить, исключить или вернуть в нейтральное состояние
--     любого финалиста.
--   • Финалы не дают очков в рейтинг: состав финала собирается по рейтингу,
--     и очки за финал X поднимали бы игрока в рейтинге к финалу X+1.
--   • Отказ уходит в служебную TG-группу (op_type=DECLINE), действия админа —
--     без сообщения (op_type=SILENT), только пост в канале обновляется.
--
-- Применять после 032. Идемпотентно.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Колонки и таблица отказов ───────────────────────────────────────────
alter table public.tournaments
  add column if not exists final_confirmations_open      boolean not null default false,
  add column if not exists final_confirmations_opened_at timestamptz,
  add column if not exists final_rating_month            text;

alter table public.tournaments drop constraint if exists tournaments_final_rating_month_check;
alter table public.tournaments add constraint tournaments_final_rating_month_check
  check (final_rating_month is null or final_rating_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- Уже сыгранные финалы собирались руками — для них подтверждения открыты.
update public.tournaments
   set final_confirmations_open = true,
       final_confirmations_opened_at = coalesce(final_confirmations_opened_at, now())
 where is_monthly_final and status in ('past', 'cancelled') and not final_confirmations_open;

create table if not exists public.final_declines (
  tournament_id  bigint not null references public.tournaments (id) on delete cascade,
  player_id      bigint not null references public.players (id) on delete cascade,
  status         text not null default 'pending' check (status in ('pending', 'approved')),
  created_at     timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

-- Читают и меняют только через функции ниже; напрямую — админ.
alter table public.final_declines enable row level security;
drop policy if exists final_declines_admin on public.final_declines;
create policy final_declines_admin on public.final_declines
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── 2. Рейтинг без финалов ─────────────────────────────────────────────────
-- Как в 029; единственная правка — в eligible: снимок финала месяца не в счёт.
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
        select 1 from public.tournaments t
         where t.id = tr.tournament_id and t.status = 'past' and not t.is_monthly_final))
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

-- ── 3. Состав финала ───────────────────────────────────────────────────────
-- За какой месяц финал: явный final_rating_month или месяц перед датой.
create or replace function public.vp_final_period(p_tournament_id bigint)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(t.final_rating_month, to_char(
           date_trunc('month', coalesce(t.date, now()) at time zone 'Europe/Moscow') - interval '1 month',
           'YYYY-MM'))
    from public.tournaments t where t.id = p_tournament_id;
$$;
grant execute on function public.vp_final_period(bigint) to anon, authenticated;

-- seat — место в составе (1…N) после исключённых; rating_rank — место в
-- рейтинге месяца как есть. Кого админ записал сверх топа руками (по старой
-- схеме или гостя), отдаём в конце с extra=true и seat=null: запись у него
-- есть, прятать его из списка нельзя.
-- Игроки без профиля (результат записан только именем) в состав не идут:
-- подтвердить участие им нечем.
create or replace function public.vp_final_roster(p_tournament_id bigint)
returns table (player_id bigint, name text, photo_url text, level integer, rank_key text,
               points bigint, ko bigint, rating_rank bigint, seat integer,
               confirmed boolean, declined boolean, extra boolean)
language sql stable security definer set search_path = public
as $$
  with t as (
    select id, coalesce(slots, 27) as slots from public.tournaments
     where id = p_tournament_id and is_monthly_final
  ), lb as (
    select r.player_id, r.name, r.photo_url, r.level, r.rank_key, r.points, r.ko, r.rank,
           row_number() over (order by r.points desc, r.ko desc, r.name, r.player_id)::integer as seat
      from public.vp_app_rating(public.vp_final_period(p_tournament_id)) r
     where exists (select 1 from t)
       and r.player_id is not null and r.points > 0
       and not exists (select 1 from public.final_declines d
                        where d.tournament_id = p_tournament_id and d.player_id = r.player_id
                          and d.status = 'approved')
  ), top as (
    select * from lb where seat <= (select slots from t)
  ), extra as (
    select p.id as player_id, p.name, p.photo_url, lv.level, lv.rank_key, reg.created_at
      from public.registrations reg
      join public.players p on p.id = reg.player_id
      left join public.vp_xp_totals x on x.player_id = p.id
      left join lateral (
        select l.level, l.rank_key from public.vp_levels l
         where l.xp_from <= coalesce(x.xp, 0) order by l.level desc limit 1
      ) lv on true
     where reg.tournament_id = p_tournament_id and reg.status = 'registered'
       and exists (select 1 from t)
       and not exists (select 1 from top where top.player_id = reg.player_id)
  )
  select top.player_id, top.name, top.photo_url, top.level, top.rank_key, top.points, top.ko,
         top.rank, top.seat,
         exists (select 1 from public.registrations reg
                  where reg.tournament_id = p_tournament_id and reg.player_id = top.player_id
                    and reg.status = 'registered'),
         exists (select 1 from public.final_declines d
                  where d.tournament_id = p_tournament_id and d.player_id = top.player_id
                    and d.status = 'pending'),
         false
    from top
  union all
  select e.player_id, e.name, e.photo_url, e.level, e.rank_key, null, null, null, null,
         true, false, true
    from extra e
  order by 12, 9 nulls last, 2;
$$;
grant execute on function public.vp_final_roster(bigint) to anon, authenticated;

-- Исключённые — для админки, чтобы было кого вернуть.
create or replace function public.vp_final_excluded(p_tournament_id bigint)
returns table (player_id bigint, name text)
language sql stable security definer set search_path = public
as $$
  select d.player_id, p.name
    from public.final_declines d join public.players p on p.id = d.player_id
   where d.tournament_id = p_tournament_id and d.status = 'approved' and public.is_admin()
   order by d.created_at;
$$;
grant execute on function public.vp_final_excluded(bigint) to authenticated;

-- ── 4. Ответ игрока: «Буду» / «Не смогу» ───────────────────────────────────
create or replace function public.vp_app_final_respond(p_token text, p_tournament_id bigint, p_going boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id     bigint := public.vp_session_player(p_token);
  v_final  boolean;
  v_open   boolean;
  v_status text;
  v_count  integer;
begin
  select t.is_monthly_final, t.final_confirmations_open, t.status
    into v_final, v_open, v_status
    from public.tournaments t where t.id = p_tournament_id
     for update;
  if v_status is null then raise exception 'tournament_not_found'; end if;
  if not v_final then raise exception 'not_a_final'; end if;
  if v_status not in ('open', 'running') then raise exception 'registration_closed'; end if;
  if not v_open then raise exception 'confirmations_closed'; end if;
  if not exists (select 1 from public.vp_final_roster(p_tournament_id) r
                  where r.player_id = v_id and not r.extra) then
    raise exception 'not_in_final';
  end if;

  if p_going then
    delete from public.final_declines
     where tournament_id = p_tournament_id and player_id = v_id;
    insert into public.registrations (tournament_id, player_id, status)
    values (p_tournament_id, v_id, 'registered')
    on conflict (tournament_id, player_id)
      do update set status = 'registered', created_at = now();
  else
    -- Об отказе группе пишет триггер final_declines; «отменил запись» от
    -- registrations рядом с ним — лишнее и путает.
    perform set_config('vp.final_notify', 'silent', true);
    update public.registrations set status = 'cancelled'
     where tournament_id = p_tournament_id and player_id = v_id;
    perform public.vp_unsync_registration(p_tournament_id, v_id);
    perform set_config('vp.final_notify', '', true);
    insert into public.final_declines (tournament_id, player_id, status)
    values (p_tournament_id, v_id, 'pending')
    on conflict (tournament_id, player_id)
      do update set status = 'pending', created_at = now();
  end if;

  select registered_count into v_count from public.tournaments where id = p_tournament_id;
  return json_build_object('going', p_going, 'registered_count', coalesce(v_count, 0));
end;
$$;
revoke all on function public.vp_app_final_respond(text, bigint, boolean) from public;
grant execute on function public.vp_app_final_respond(text, bigint, boolean) to anon, authenticated;

-- ── 5. Решения админа ──────────────────────────────────────────────────────
-- confirm — подтвердить за игрока (и снять его отказ);
-- exclude — исключить (или принять отказ), место переходит следующему;
-- reset   — вернуть в нейтральное: ни отказа, ни подтверждения.
create or replace function public.vp_final_admin_set(p_tournament_id bigint, p_player_id bigint, p_action text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  if not exists (select 1 from public.tournaments where id = p_tournament_id and is_monthly_final) then
    raise exception 'not_a_final';
  end if;
  if p_action not in ('confirm', 'exclude', 'reset') then raise exception 'bad_action'; end if;

  -- Админ сам знает, что сделал, — в группу не пишем, пост в канале правим.
  perform set_config('vp.final_notify', 'silent', true);

  if p_action = 'confirm' then
    delete from public.final_declines where tournament_id = p_tournament_id and player_id = p_player_id;
    insert into public.registrations (tournament_id, player_id, status)
    values (p_tournament_id, p_player_id, 'registered')
    on conflict (tournament_id, player_id)
      do update set status = 'registered', created_at = now();
  else
    if p_action = 'exclude' then
      insert into public.final_declines (tournament_id, player_id, status)
      values (p_tournament_id, p_player_id, 'approved')
      on conflict (tournament_id, player_id) do update set status = 'approved';
    else
      delete from public.final_declines where tournament_id = p_tournament_id and player_id = p_player_id;
    end if;
    update public.registrations set status = 'cancelled'
     where tournament_id = p_tournament_id and player_id = p_player_id and status = 'registered';
    perform public.vp_unsync_registration(p_tournament_id, p_player_id);
  end if;

  perform set_config('vp.final_notify', '', true);
  return json_build_object('ok', true);
end;
$$;
revoke all on function public.vp_final_admin_set(bigint, bigint, text) from public;
grant execute on function public.vp_final_admin_set(bigint, bigint, text) to authenticated;

create or replace function public.vp_final_set_confirmations(p_tournament_id bigint, p_open boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'not_authorized'; end if;
  update public.tournaments
     set final_confirmations_open = coalesce(p_open, false),
         final_confirmations_opened_at = case when p_open
           then coalesce(final_confirmations_opened_at, now()) else final_confirmations_opened_at end
   where id = p_tournament_id and is_monthly_final;
  if not found then raise exception 'not_a_final'; end if;
  return json_build_object('ok', true, 'open', coalesce(p_open, false));
end;
$$;
revoke all on function public.vp_final_set_confirmations(bigint, boolean) from public;
grant execute on function public.vp_final_set_confirmations(bigint, boolean) to authenticated;

-- ── 6. Уведомления ─────────────────────────────────────────────────────────
-- Как в 012, плюс флаг vp.final_notify: 'silent' — сообщение в группу не
-- нужно (функция только правит пост в канале).
create or replace function public._notify_admin_on_registration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tournament_id  bigint;
  v_player_id      bigint;
  v_op             text;
  v_edge_url       text;
  v_secret         text;
  v_anon_key       text;
begin
  v_tournament_id := coalesce(new.tournament_id, old.tournament_id);
  v_player_id     := coalesce(new.player_id, old.player_id);

  if tg_op = 'INSERT' then
    v_op := 'INSERT';
  elsif tg_op = 'UPDATE' then
    if new.status = old.status then
      return coalesce(new, old);
    end if;
    v_op := case when new.status = 'cancelled' then 'CANCEL' else 'INSERT' end;
  else
    return coalesce(new, old);
  end if;

  if current_setting('vp.final_notify', true) = 'silent' then
    v_op := 'SILENT';
  end if;

  select value into v_edge_url from public._app_config where key = 'edge_url';
  select value into v_secret   from public._app_config where key = 'cron_secret';
  select value into v_anon_key from public._app_config where key = 'anon_key';

  if v_edge_url is null or v_secret is null or v_anon_key is null then
    return coalesce(new, old);
  end if;

  perform net.http_post(
    url     := v_edge_url || '/tournament-notify',
    body    := json_build_object(
                 'action',        'notify',
                 'tournament_id', v_tournament_id,
                 'player_id',     v_player_id,
                 'op_type',       v_op
               )::jsonb,
    headers := json_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_secret,
                 'apikey',        v_anon_key
               )::jsonb
  );

  return coalesce(new, old);
end;
$$;

-- Отказ игрока — отдельным сообщением: админу надо принять решение.
create or replace function public._notify_admin_on_final_decline()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_edge_url text;
  v_secret   text;
  v_anon_key text;
begin
  if new.status <> 'pending' or (tg_op = 'UPDATE' and old.status = 'pending') then
    return new;
  end if;

  select value into v_edge_url from public._app_config where key = 'edge_url';
  select value into v_secret   from public._app_config where key = 'cron_secret';
  select value into v_anon_key from public._app_config where key = 'anon_key';
  if v_edge_url is null or v_secret is null or v_anon_key is null then
    return new;
  end if;

  perform net.http_post(
    url     := v_edge_url || '/tournament-notify',
    body    := json_build_object(
                 'action',        'notify',
                 'tournament_id', new.tournament_id,
                 'player_id',     new.player_id,
                 'op_type',       'DECLINE'
               )::jsonb,
    headers := json_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_secret,
                 'apikey',        v_anon_key
               )::jsonb
  );
  return new;
end;
$$;

drop trigger if exists trg_admin_notify_on_final_decline on public.final_declines;
create trigger trg_admin_notify_on_final_decline
  after insert or update on public.final_declines
  for each row execute function public._notify_admin_on_final_decline();

notify pgrst, 'reload schema';
