-- Пост со списком участников в Telegram-канале клуба.
--
-- В день турнира в 15:00 МСК внешний cron дёргает tournament-notify
-- (action=publish): бот публикует пост «ТУРНИР СЕГОДНЯ» со списком записавшихся.
-- Дальше каждая запись/отмена (тот же триггер из 012, action=notify) правит
-- этот пост на месте. Здесь запоминаем, какое сообщение чьё.
--
-- Канал — в _app_config('tg_channel_id'): удалить строку = выключить
-- автопостинг, не трогая код и контейнер. Бот должен быть админом канала
-- с правом публиковать и редактировать сообщения.

create table if not exists public.tg_channel_posts (
  tournament_id  bigint primary key references public.tournaments (id) on delete cascade,
  chat_id        text not null,
  -- null — пост «занят» вызовом, который прямо сейчас его публикует:
  -- две записи в одну секунду не должны дать два поста.
  message_id     bigint,
  text           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.tg_channel_posts enable row level security;
revoke all on public.tg_channel_posts from anon, authenticated;

insert into public._app_config (key, value) values ('tg_channel_id', '-1002846277326')
on conflict (key) do update set value = excluded.value;
