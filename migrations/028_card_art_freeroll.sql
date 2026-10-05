-- Пятое оформление карточки турнира — «Фриролл» (assets/art/freeroll.webp).
alter table public.tournaments drop constraint if exists tournaments_card_art_check;
alter table public.tournaments add constraint tournaments_card_art_check
  check (card_art is null or card_art in ('joker', 'knockout', 'phoenix', 'doublelife', 'freeroll'));

-- PostgREST кэширует схему: сменившийся check виден только после перезагрузки.
notify pgrst, 'reload schema';
