-- ═══════════════════════════════════════════════════════════════════════════
-- Итоги турниров — хранилище CRM.
--
-- До этой миграции вечер жил только в rooms.state: комнату пересоздали или
-- сбросили — и от турнира не осталось ничего. Показателям игрока и отчёту за
-- период опереться было не на что, поэтому оплата уезжала разовой выгрузкой
-- в Google Sheets и обратно в клуб не возвращалась.
--
-- Теперь админка по кнопке кладёт СНИМОК турнира: шапка в tournament_results,
-- строка на игрока в tournament_result_players. Снимок, а не ссылка на комнату:
-- комната переживёт правку структуры и сброс, отчёт за март — нет.
--
-- Повторное сохранение того же турнира перезаписывает снимок по report_key
-- (`<room_id>__<tournament.createdAt>`): вечер сохраняют и посреди турнира,
-- и после разбора поста, и каждый раз это одна и та же строка.
--
-- Применять после 001_init.sql. Идемпотентно.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Шапка турнира ──────────────────────────────────────────────────────────
-- Денежные поля целые, в рублях. Суммы дублируют сумму детей осознанно:
-- отчёт за период читает только шапки, без выборки по всем игрокам.
create table if not exists public.tournament_results (
  id             bigserial primary key,
  report_key     text not null unique,
  room_id        text,
  tournament_id  bigint references public.tournaments (id) on delete set null,
  name           text not null default '',
  played_at      timestamptz not null default now(),
  buy_in         integer not null default 0,
  pko            boolean not null default false,
  players_count  integer not null default 0,   -- пришедшие
  entries        integer not null default 0,   -- входы = пришедшие + реентри
  reentries      integer not null default 0,
  addons         integer not null default 0,
  expected       integer not null default 0,   -- к оплате
  paid           integer not null default 0,
  debt           integer not null default 0,
  transfer       integer not null default 0,
  cash           integer not null default 0,
  card           integer not null default 0,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists tournament_results_played_idx
  on public.tournament_results (played_at desc);

drop trigger if exists tournament_results_touch on public.tournament_results;
create trigger tournament_results_touch
  before update on public.tournament_results
  for each row execute function public.touch_updated_at();

-- ── Строка игрока ──────────────────────────────────────────────────────────
-- player_id может быть пустым: в зал приходят незаведённые, и стопорить
-- посадку из-за этого нельзя (так же устроен список в админке). Поэтому рядом
-- лежит name_key — свёрнутое имя, по нему CRM сшивает такого игрока с самим
-- собой в других турнирах. Свёртка повторяет players.name_key из 001_init.sql.
create table if not exists public.tournament_result_players (
  id            bigserial primary key,
  result_id     bigint not null references public.tournament_results (id) on delete cascade,
  player_id     bigint references public.players (id) on delete set null,
  name          text not null,
  name_key      text generated always as (
                  regexp_replace(lower(translate(name, 'ЁёЙй', 'ЕеИи')), '\s+', ' ', 'g')
                ) stored,
  place         integer,                       -- null — остался в игре на момент снимка
  entries       integer not null default 1,
  reentries     integer not null default 0,
  addon         boolean not null default false,
  ko            integer not null default 0,
  ko_pts        integer not null default 0,
  points        integer not null default 0,    -- очки призовой зоны за место
  buy_in        integer not null default 0,
  expected      integer not null default 0,
  paid          integer not null default 0,
  debt          integer not null default 0,
  transfer      integer not null default 0,
  cash          integer not null default 0,
  card          integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (result_id, name_key)
);

create index if not exists trp_result_idx on public.tournament_result_players (result_id);
create index if not exists trp_player_idx on public.tournament_result_players (player_id);
create index if not exists trp_name_key_idx on public.tournament_result_players (name_key);

-- ── Права ──────────────────────────────────────────────────────────────────
alter table public.tournament_results enable row level security;
alter table public.tournament_result_players enable row level security;

-- Читают все свои: CRM клубная, оператор видит те же показатели, что админ.
drop policy if exists results_read on public.tournament_results;
create policy results_read on public.tournament_results
  for select to authenticated using (auth.uid() is not null);

drop policy if exists result_players_read on public.tournament_result_players;
create policy result_players_read on public.tournament_result_players
  for select to authenticated using (auth.uid() is not null);

-- Пишет тот, кто вёл вечер, — то есть любой свой. Ограничить запись админом
-- нельзя: снимок сохраняет оператор из админки своей комнаты, и админа в зале
-- в этот момент нет.
drop policy if exists results_write on public.tournament_results;
create policy results_write on public.tournament_results
  for insert to authenticated with check (auth.uid() is not null);

drop policy if exists results_update on public.tournament_results;
create policy results_update on public.tournament_results
  for update to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

drop policy if exists result_players_write on public.tournament_result_players;
create policy result_players_write on public.tournament_result_players
  for insert to authenticated with check (auth.uid() is not null);

drop policy if exists result_players_update on public.tournament_result_players;
create policy result_players_update on public.tournament_result_players
  for update to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);

-- Пересохранение турнира начинается с удаления его строк игроков: список мог
-- ужаться (ошибочного «пришёл» сняли), и остаток старого снимка попал бы
-- в показатели игрока, которого в турнире не было.
drop policy if exists result_players_delete on public.tournament_result_players;
create policy result_players_delete on public.tournament_result_players
  for delete to authenticated using (auth.uid() is not null);

-- Удаление самого отчёта — операция администратора: это стирание истории.
drop policy if exists results_delete_admin on public.tournament_results;
create policy results_delete_admin on public.tournament_results
  for delete to authenticated using (public.is_admin());
