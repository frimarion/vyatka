-- ═══════════════════════════════════════════════════════════════════════════
-- Замена макетов турниров на реальный формат клуба + цена аддона в макете.
--
-- «Вятский Дейли», «Турбо» и «Глубокий стек» из 003_blueprints.sql были
-- заглушками для теста — в клубе играют один формат, «Классика». Удаляем
-- выдуманные макеты (если их не трогали из админки — тогда это чьи-то правки,
-- а не заглушки, и их лучше не стирать) и добавляем настоящий.
--
-- default_reentry — та же колонка, что должна была прийти из 007_blueprint_
-- reentry.sql; на бою её не оказалось (сервер разошёлся с migrations/), поэтому
-- заводим здесь же, идемпотентно.
--
-- default_addon_stack/default_addon_cost — цена аддона до сих пор жила только
-- в state.tournament, отдельно на каждый турнир: оператор проставлял её руками
-- при каждом создании. У клуба один размер аддона на формат, так что кладём
-- его в макет — применение формата сразу включает аддон нужного размера.
--
-- Идущих турниров правка не касается: у них своя копия уровней в state.
--
-- Применять после 003_blueprints.sql. Идемпотентно.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.tournament_blueprints
  add column if not exists default_reentry integer check (default_reentry >= 0);

alter table public.tournament_blueprints
  add column if not exists default_addon_stack integer check (default_addon_stack >= 0);

alter table public.tournament_blueprints
  add column if not exists default_addon_cost integer check (default_addon_cost >= 0);

delete from public.tournament_blueprints
 where name in ('Вятский Дейли', 'Турбо', 'Глубокий стек');

insert into public.tournament_blueprints
  (name, start_stack, late_reg_until_level, default_buy_in, default_reentry, default_addon_stack, default_addon_cost, levels, sort_order)
select * from (values
  ('Классика', 40000, 8, 700, 500, 80000, 700, $json$[
    {"min":20,"sb":100,"bb":200,"anteMode":"BB"},{"min":20,"sb":200,"bb":400,"anteMode":"BB"},
    {"min":20,"sb":300,"bb":600,"anteMode":"BB"},{"min":20,"sb":400,"bb":800,"anteMode":"BB"},
    {"isBreak":true,"min":12,"label":"Перерыв"},
    {"min":18,"sb":500,"bb":1000,"anteMode":"BB"},{"min":18,"sb":600,"bb":1200,"anteMode":"BB"},
    {"min":18,"sb":800,"bb":1600,"anteMode":"BB"},{"min":16,"sb":1000,"bb":2000,"anteMode":"BB"},
    {"isBreak":true,"min":15,"label":"Перерыв"},
    {"min":16,"sb":1500,"bb":3000,"anteMode":"BB"},{"min":16,"sb":2000,"bb":4000,"anteMode":"BB"},
    {"min":16,"sb":3000,"bb":6000,"anteMode":"BB"},{"min":14,"sb":4000,"bb":8000,"anteMode":"BB"},
    {"min":14,"sb":5000,"bb":10000,"anteMode":"BB"},
    {"isBreak":true,"min":10,"label":"Перерыв"},
    {"min":12,"sb":6000,"bb":12000,"anteMode":"BB"},{"min":12,"sb":7000,"bb":14000,"anteMode":"BB"},
    {"min":12,"sb":8000,"bb":16000,"anteMode":"BB"},{"min":12,"sb":10000,"bb":20000,"anteMode":"BB"},
    {"min":10,"sb":15000,"bb":30000,"anteMode":"BB"},
    {"isBreak":true,"min":10,"label":"Перерыв"},
    {"min":10,"sb":20000,"bb":40000,"anteMode":"BB"},{"min":10,"sb":30000,"bb":60000,"anteMode":"BB"},
    {"min":8,"sb":40000,"bb":80000,"anteMode":"BB"},{"min":8,"sb":50000,"bb":100000,"anteMode":"BB"},
    {"min":8,"sb":75000,"bb":150000,"anteMode":"BB"},
    {"min":6,"sb":100000,"bb":200000,"anteMode":"BB"},{"min":6,"sb":150000,"bb":300000,"anteMode":"BB"},
    {"min":6,"sb":200000,"bb":400000,"anteMode":"BB"}
  ]$json$::jsonb, 1)
) as seed(name, start_stack, late_reg_until_level, default_buy_in, default_reentry, default_addon_stack, default_addon_cost, levels, sort_order)
where not exists (select 1 from public.tournament_blueprints where name = 'Классика');

select id, name, start_stack, default_buy_in, default_reentry, default_addon_stack, default_addon_cost, sort_order
  from public.tournament_blueprints order by sort_order, id;
