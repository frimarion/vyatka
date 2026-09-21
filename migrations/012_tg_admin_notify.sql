-- ═══════════════════════════════════════════════════════════════════════════
-- Уведомления в служебную Telegram-группу — по аналогии с Дойлом.
--
-- Два сценария:
--   1. Запись/отмена игрока → триггер на registrations дёргает Edge Function
--      tournament-notify (action=notify), она шлёт сообщение в группу.
--   2. Утро турнирного дня → внешний cron (VPS) дёргает ту же функцию
--      (action=prepare), она собирает черновик поста с текущим списком
--      записавшихся и присылает его в группу — просто текст, скопировать
--      и запостить руками, автопубликации в канал здесь нет.
--
-- _app_config хранит адрес функции и секреты, которыми БД сама себя
-- авторизует при вызове наружу через pg_net — то же решение, что у Дойла
-- (add_tournament_announcement.sql, notify_admin_on_player_reg.sql).
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public._app_config (
  key    text primary key,
  value  text not null
);
alter table public._app_config enable row level security;
revoke all on public._app_config from anon, authenticated;

-- pg_net идёт в комплекте с self-hosted Supabase (тот же образ, что у Дойла).
create extension if not exists pg_net with schema extensions;

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
    -- Триггер висит на "update of status": сюда доезжают только реальные
    -- переходы статуса (регистрация ↔ отмена), а не любое обновление строки.
    if new.status = old.status then
      return coalesce(new, old);
    end if;
    v_op := case when new.status = 'cancelled' then 'CANCEL' else 'INSERT' end;
  else
    return coalesce(new, old);
  end if;

  select value into v_edge_url from public._app_config where key = 'edge_url';
  select value into v_secret   from public._app_config where key = 'cron_secret';
  select value into v_anon_key from public._app_config where key = 'anon_key';

  -- Секреты ещё не разложены (см. deploy/README.md) — молча выходим, а не
  -- роняем регистрацию игрока из-за недонастроенных уведомлений.
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

drop trigger if exists trg_admin_notify_on_reg_change on public.registrations;
create trigger trg_admin_notify_on_reg_change
  after insert or update of status on public.registrations
  for each row execute function public._notify_admin_on_registration();

-- ──────────────────────────────────────────────────────────────────────────────
-- После деплоя Edge Function (см. deploy/README.md) разложить конфиг — на базе,
-- под postgres, не под приложением:
--
--   insert into public._app_config (key, value) values
--     ('edge_url',    'https://api.vyatkapoker.ru/functions/v1'),
--     ('cron_secret', '<тот же секрет, что уйдёт в CRON_SECRET контейнера functions>'),
--     ('anon_key',    '<ANON_KEY из js/config.js>')
--   on conflict (key) do update set value = excluded.value;
--
-- VPS cron на утренний черновик поста (07:00 UTC = 10:00 MSK):
--
--   0 7 * * * curl -s -X POST https://api.vyatkapoker.ru/functions/v1/tournament-notify \
--     -H "apikey: <ANON_KEY>" \
--     -H "Authorization: Bearer <CRON_SECRET>" \
--     -H "Content-Type: application/json" \
--     -d '{"action":"prepare"}' >> /var/log/vyatka-announce.log 2>&1
-- ──────────────────────────────────────────────────────────────────────────────
