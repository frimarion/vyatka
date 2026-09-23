-- Оформление карточки турнира в приложении: «Джокер», «Нокаут», «Феникс» —
-- картинка справа, информация слева (assets/art/<значение>.webp). Текстом,
-- а не флагами: следующий формат — ещё одно значение в check, а не колонка.
alter table public.tournaments add column if not exists card_art text;

alter table public.tournaments drop constraint if exists tournaments_card_art_check;
alter table public.tournaments add constraint tournaments_card_art_check
  check (card_art is null or card_art in ('joker', 'knockout', 'phoenix'));

-- PostgREST кэширует схему: без перезагрузки новая колонка не видна ни
-- в select("*"), ни в update из админки.
notify pgrst, 'reload schema';
