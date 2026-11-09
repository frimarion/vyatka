-- Оформление карточки турнира «Фризаут» (assets/art/freezeout.webp).
begin;
alter table public.tournaments drop constraint if exists tournaments_card_art_check;
alter table public.tournaments add constraint tournaments_card_art_check
  check (card_art is null or card_art in ('joker', 'knockout', 'phoenix', 'doublelife', 'freeroll', 'mafia', 'freezeout'));

notify pgrst, 'reload schema';
commit;
