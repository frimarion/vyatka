-- ═══════════════════════════════════════════════════════════════════════════
-- Макеты турниров.
--
-- До этой миграции форматы («Вятский Дейли», «Турбо», «Глубокий стек») жили
-- хардкодом в js/core.js: поменять структуру блайндов значило править код и
-- выкладывать фронт. Теперь они строки в таблице, редактируемые из админки.
--
-- Применение макета КОПИРУЕТ levels в state.structure.levels комнаты. Правка
-- или удаление макета не трогает уже идущие турниры — иначе редактирование
-- посреди вечера переписало бы структуру под игроками.
--
-- Применять после 001_init.sql. Идемпотентно.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.tournament_blueprints (
  id                    bigserial primary key,
  name                  text not null check (length(trim(name)) between 1 and 80),
  start_stack           integer not null check (start_stack > 0),
  late_reg_until_level  integer not null default 0 check (late_reg_until_level >= 0),
  default_buy_in        integer check (default_buy_in >= 0),
  levels                jsonb not null,
  sort_order            integer not null default 0,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists tournament_blueprints_sort_idx
  on public.tournament_blueprints (sort_order, id);

alter table public.tournament_blueprints enable row level security;

-- Читают все свои: оператор ведёт турнир и должен уметь применить формат.
-- У Дойла политика admin-only на всё — там оператор не увидел бы ни одного
-- макета, и вкладка «Формат турнира» оказалась бы для него пустой.
drop policy if exists blueprints_read on public.tournament_blueprints;
create policy blueprints_read on public.tournament_blueprints
  for select to authenticated
  using (true);

-- Пишет только админ: макет общий для клуба, правка задевает все будущие турниры.
drop policy if exists blueprints_write on public.tournament_blueprints;
create policy blueprints_write on public.tournament_blueprints
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ── Стартовые макеты ───────────────────────────────────────────────────────
-- Те же три, что лежали в PRESETS: после миграции поведение не меняется.
-- Вставляем только в пустую таблицу, чтобы повторный прогон не плодил дубли
-- и не затирал правки, сделанные из админки.
insert into public.tournament_blueprints (name, start_stack, late_reg_until_level, default_buy_in, levels, sort_order)
select * from (values
  ('Вятский Дейли', 30000, 9, 1000, $json$[
    {"min":16,"sb":100,"bb":100,"anteMode":"BB"},{"min":16,"sb":100,"bb":200,"anteMode":"BB"},
    {"min":16,"sb":100,"bb":300,"anteMode":"BB"},{"min":16,"sb":200,"bb":400,"anteMode":"BB"},
    {"min":16,"sb":300,"bb":600,"anteMode":"BB"},{"min":16,"sb":400,"bb":800,"anteMode":"BB"},
    {"isBreak":true,"min":15,"label":"Перерыв"},
    {"min":16,"sb":500,"bb":1000,"anteMode":"BB"},{"min":16,"sb":600,"bb":1200,"anteMode":"BB"},
    {"min":16,"sb":800,"bb":1600,"anteMode":"BB"},{"min":12,"sb":1000,"bb":2000,"anteMode":"BB"},
    {"min":12,"sb":1000,"bb":3000,"anteMode":"BB"},{"min":12,"sb":2000,"bb":4000,"anteMode":"BB"},
    {"min":12,"sb":2000,"bb":5000,"anteMode":"BB"},{"min":12,"sb":3000,"bb":6000,"anteMode":"BB"},
    {"min":12,"sb":4000,"bb":8000,"anteMode":"BB"},{"min":12,"sb":5000,"bb":10000,"anteMode":"BB"},
    {"min":12,"sb":6000,"bb":12000,"anteMode":"BB"},{"min":12,"sb":8000,"bb":16000,"anteMode":"BB"},
    {"min":12,"sb":10000,"bb":20000,"anteMode":"BB"},{"min":10,"sb":15000,"bb":30000,"anteMode":"BB"},
    {"min":10,"sb":20000,"bb":40000,"anteMode":"BB"},{"min":10,"sb":30000,"bb":60000,"anteMode":"BB"},
    {"min":10,"sb":40000,"bb":80000,"anteMode":"BB"},{"min":10,"sb":50000,"bb":100000,"anteMode":"BB"}
  ]$json$::jsonb, 1),
  ('Турбо', 20000, 6, 1000, $json$[
    {"min":10,"sb":100,"bb":100,"anteMode":"BB"},{"min":10,"sb":100,"bb":200,"anteMode":"BB"},
    {"min":10,"sb":200,"bb":400,"anteMode":"BB"},{"min":10,"sb":300,"bb":600,"anteMode":"BB"},
    {"min":10,"sb":400,"bb":800,"anteMode":"BB"},{"min":10,"sb":500,"bb":1000,"anteMode":"BB"},
    {"isBreak":true,"min":10,"label":"Перерыв"},
    {"min":10,"sb":600,"bb":1200,"anteMode":"BB"},{"min":10,"sb":800,"bb":1600,"anteMode":"BB"},
    {"min":10,"sb":1000,"bb":2000,"anteMode":"BB"},{"min":10,"sb":1500,"bb":3000,"anteMode":"BB"},
    {"min":10,"sb":2000,"bb":4000,"anteMode":"BB"},{"min":10,"sb":3000,"bb":6000,"anteMode":"BB"},
    {"min":10,"sb":4000,"bb":8000,"anteMode":"BB"},{"min":10,"sb":5000,"bb":10000,"anteMode":"BB"},
    {"min":10,"sb":8000,"bb":16000,"anteMode":"BB"},{"min":10,"sb":10000,"bb":20000,"anteMode":"BB"},
    {"min":10,"sb":15000,"bb":30000,"anteMode":"BB"},{"min":10,"sb":20000,"bb":40000,"anteMode":"BB"}
  ]$json$::jsonb, 2),
  ('Глубокий стек', 50000, 12, 2000, $json$[
    {"min":20,"sb":100,"bb":100,"anteMode":"BB"},{"min":20,"sb":100,"bb":200,"anteMode":"BB"},
    {"min":20,"sb":100,"bb":300,"anteMode":"BB"},{"min":20,"sb":200,"bb":400,"anteMode":"BB"},
    {"min":20,"sb":300,"bb":600,"anteMode":"BB"},{"min":20,"sb":400,"bb":800,"anteMode":"BB"},
    {"isBreak":true,"min":15,"label":"Перерыв"},
    {"min":20,"sb":500,"bb":1000,"anteMode":"BB"},{"min":20,"sb":600,"bb":1200,"anteMode":"BB"},
    {"min":20,"sb":800,"bb":1600,"anteMode":"BB"},{"min":15,"sb":1000,"bb":2000,"anteMode":"BB"},
    {"min":15,"sb":1000,"bb":3000,"anteMode":"BB"},{"min":15,"sb":2000,"bb":4000,"anteMode":"BB"},
    {"min":15,"sb":2000,"bb":5000,"anteMode":"BB"},{"min":15,"sb":3000,"bb":6000,"anteMode":"BB"},
    {"min":15,"sb":4000,"bb":8000,"anteMode":"BB"},{"min":15,"sb":5000,"bb":10000,"anteMode":"BB"},
    {"min":15,"sb":6000,"bb":12000,"anteMode":"BB"},{"min":15,"sb":8000,"bb":16000,"anteMode":"BB"},
    {"min":12,"sb":10000,"bb":20000,"anteMode":"BB"},{"min":12,"sb":15000,"bb":30000,"anteMode":"BB"},
    {"min":12,"sb":20000,"bb":40000,"anteMode":"BB"},{"min":12,"sb":30000,"bb":60000,"anteMode":"BB"},
    {"min":12,"sb":40000,"bb":80000,"anteMode":"BB"},{"min":12,"sb":50000,"bb":100000,"anteMode":"BB"}
  ]$json$::jsonb, 3)
) as seed(name, start_stack, late_reg_until_level, default_buy_in, levels, sort_order)
where not exists (select 1 from public.tournament_blueprints);

select id, name, start_stack, late_reg_until_level, sort_order
  from public.tournament_blueprints order by sort_order, id;
