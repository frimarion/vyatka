-- ═══════════════════════════════════════════════════════════════════════════
-- Второй формат клуба: «Турбо».
--
-- Тот же взнос/реентри/аддон, что у «Классики» (700/500/тройной стек за
-- 1000 ₽), но короче уровни — с 14 минут в начале до 6 к концу вместо
-- 20→6 у «Классики», и старт с 100:100 вместо 100:200.
--
-- Применять после 014_blueprint_classic.sql. Идемпотентно.
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.tournament_blueprints
  (name, start_stack, late_reg_until_level, default_buy_in, default_reentry, default_addon_stack, default_addon_cost, levels, sort_order)
select * from (values
  ('Турбо', 30000, 9, 700, 500, 90000, 1000, $json$[
    {"min":14,"sb":100,"bb":100,"anteMode":"BB"},{"min":14,"sb":100,"bb":200,"anteMode":"BB"},
    {"min":14,"sb":200,"bb":400,"anteMode":"BB"},{"min":14,"sb":300,"bb":600,"anteMode":"BB"},
    {"min":14,"sb":400,"bb":800,"anteMode":"BB"},
    {"isBreak":true,"min":13,"label":"Перерыв"},
    {"min":12,"sb":500,"bb":1000,"anteMode":"BB"},{"min":12,"sb":600,"bb":1200,"anteMode":"BB"},
    {"min":12,"sb":800,"bb":1600,"anteMode":"BB"},{"min":12,"sb":1000,"bb":2000,"anteMode":"BB"},
    {"isBreak":true,"min":15,"label":"Перерыв"},
    {"min":12,"sb":1500,"bb":3000,"anteMode":"BB"},{"min":12,"sb":2000,"bb":4000,"anteMode":"BB"},
    {"min":10,"sb":3000,"bb":6000,"anteMode":"BB"},{"min":10,"sb":4000,"bb":8000,"anteMode":"BB"},
    {"min":10,"sb":5000,"bb":10000,"anteMode":"BB"},
    {"isBreak":true,"min":10,"label":"Перерыв"},
    {"min":10,"sb":6000,"bb":12000,"anteMode":"BB"},{"min":10,"sb":7000,"bb":14000,"anteMode":"BB"},
    {"min":8,"sb":8000,"bb":16000,"anteMode":"BB"},{"min":8,"sb":10000,"bb":20000,"anteMode":"BB"},
    {"min":8,"sb":15000,"bb":30000,"anteMode":"BB"},
    {"isBreak":true,"min":10,"label":"Перерыв"},
    {"min":8,"sb":20000,"bb":40000,"anteMode":"BB"},{"min":8,"sb":30000,"bb":60000,"anteMode":"BB"},
    {"min":8,"sb":40000,"bb":80000,"anteMode":"BB"},{"min":6,"sb":50000,"bb":100000,"anteMode":"BB"},
    {"min":6,"sb":75000,"bb":150000,"anteMode":"BB"},{"min":6,"sb":100000,"bb":200000,"anteMode":"BB"},
    {"min":6,"sb":150000,"bb":300000,"anteMode":"BB"},{"min":6,"sb":200000,"bb":400000,"anteMode":"BB"}
  ]$json$::jsonb, 2)
) as seed(name, start_stack, late_reg_until_level, default_buy_in, default_reentry, default_addon_stack, default_addon_cost, levels, sort_order)
where not exists (select 1 from public.tournament_blueprints where name = 'Турбо');

select id, name, start_stack, default_buy_in, default_reentry, default_addon_stack, default_addon_cost, sort_order
  from public.tournament_blueprints order by sort_order, id;
