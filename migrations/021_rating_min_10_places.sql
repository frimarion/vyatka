-- ═══════════════════════════════════════════════════════════════════════════
-- Пересчёт очков прошлых турниров под новую призовую зону.
--
-- Было: мест max(3, 15% входов) — на вечере в 35–49 входов очки получали
-- 5–7 человек. Стало (calcPayouts в js/core.js): max(10, 15% входов), но не
-- больше пришедших. Банк и геометрия те же: 100 очков за вход, r = 0.8,
-- остаток от округления — первому месту.
--
-- Гарантия в снимке не хранится, поэтому банк берём как
-- greatest(100 × входы, текущая сумма очков): турнир с гарантией сохранит
-- свой банк, остальные получат ровно 100 × входы.
--
-- Трогаем только снимки, где призовая зона была посчитана (сумма очков > 0)
-- и у всех игроков стоит место — те же, что попадают в рейтинг. Округление
-- floor(x + 0.5) в double повторяет Math.round из ядра, чтобы очки в базе
-- совпадали с тем, что показал бы зал. Идемпотентно: повторный прогон даёт
-- те же числа.
-- ═══════════════════════════════════════════════════════════════════════════

with eligible as (
  select tr.id, greatest(tr.entries, 1) as e, count(*) as n,
         greatest(100 * greatest(tr.entries, 1), sum(r.points)) as total
    from public.tournament_results tr
    join public.tournament_result_players r on r.result_id = tr.id
   group by tr.id
  having sum(r.points) > 0
     and bool_and(r.place is not null and r.place >= 1)
), weights as (
  select e.id, e.total, i as place, power(0.8::float8, i - 1) as w
    from eligible e,
         generate_series(1, greatest(1, least(e.n, greatest(10, floor(0.15 * e.e)::int)))) as i
), base as (
  select id, total, place,
         floor(total * w / sum(w) over (partition by id) + 0.5)::int as pts
    from weights
), payouts as (
  select id, place,
         pts + case when place = 1
                    then (total - sum(pts) over (partition by id))::int else 0 end as pts
    from base
)
update public.tournament_result_players r
   set points = coalesce((select p.pts from payouts p
                           where p.id = r.result_id and p.place = r.place), 0)
 where r.result_id in (select id from eligible);
