# Разворачивание на vyatkapoker.ru

Два адреса и две машины — это не усложнение, а разделение по требованиям:

| Что | Где | Почему там |
|---|---|---|
| `vyatkapoker.ru` — фронт | shared-хостинг reg.ru (Host-0) | Статика без сборки. 400 КБ HTML на 13 ГБ тарифа, PHP и MySQL не нужны вовсе. |
| `api.vyatkapoker.ru` — Supabase | свой VPS, 4 ГБ | Self-hosted Supabase — это Docker-стек из десятка контейнеров. На shared-хостинге Docker'а нет, поэтому бэкенд физически не может жить рядом с фронтом. |

Почему self-hosted, а не облако Supabase: причина та же, что у Дойла —
облачные адреса из России душат, а таймер в зале не должен зависеть от
настроения магистрали.

База поднимается **пустой**: ни одного турнира ещё не сыграно, переносить из
дойловской инсталляции нечего. Игроки заводятся через приложение и админку.

## 0. DNS (reg.ru → Домены → vyatkapoker.ru → Управление зоной)

| Запись | Тип | Значение |
|---|---|---|
| `@` | A | IP хостинга Host-0 (панель → Хостинг → Доступы) |
| `www` | A | тот же IP |
| `api` | A | IP нового VPS |

Домен в панели хостинга надо ещё и **привязать к сайту** (Хостинг → Сайты →
Добавить сайт), иначе A-запись доедет, а Apache отдаст заглушку.

Пока `api` не резолвится, certbot на шаге 4 выдаст ошибку — это нормально,
DNS расходится до получаса. Проверить: `nslookup api.vyatkapoker.ru`.

## 1. Фронт на Host-0

Заливается папка репозитория целиком (FTP или файловый менеджер панели) в
корень сайта — обычно `/var/www/uXXXXXXX/data/www/vyatkapoker.ru/`.

Обязательно вместе с `.htaccess`: в нём весь роутинг. FTP-клиенты по умолчанию
скрывают файлы с точки — включи показ скрытых, иначе корень домена отдаст
листинг вместо приложения.

Что раздаётся:

| Адрес | Файл |
|---|---|
| `vyatkapoker.ru/` | `index.html` — приложение игрока, он же Mini App |
| `/admin` | `admin.html` |
| `/tournaments` | `tournaments.html` |
| `/crm` | `crm.html` |
| `/display?room=…` | `display.html` — ссылка для ТВ |
| `/start` | `start.html` — служебный хаб со ссылками |

`migrations/`, `deploy/` и `tests/` закрыты в `.htaccess`: на shared-хостинге
выкладка идёт целой папкой, и схема базы уезжает на сервер вместе с фронтом.
Закрыть её — дешевле, чем помнить не заливать.

## 2. VPS: стек и ключи

```bash
git clone --depth 1 https://github.com/supabase/supabase
mkdir -p /opt/vyatka && cp -r supabase/docker/* /opt/vyatka/
cd /opt/vyatka && cp .env.example .env
```

Ключи генерируются на рабочей машине, из репозитория Вятки:

```bash
node deploy/gen-keys.mjs
```

Пять строк из вывода переносятся в `/opt/vyatka/.env`. `SERVICE_ROLE_KEY`
обходит RLS полностью — он живёт только в `.env` на сервере и, если нужен
локально, в файле вне репозитория. `ANON_KEY` оттуда же идёт в
[../js/config.js](../js/config.js) вместо `PASTE_ANON_KEY_FROM_GEN_KEYS`:
пока он не вставлен, в консоли браузера висит прямая ругань об этом.

Там же в `.env` правится:

| Переменная | Значение |
|---|---|
| `API_EXTERNAL_URL`, `SUPABASE_PUBLIC_URL` | `https://api.vyatkapoker.ru` |
| `SITE_URL` | `https://vyatkapoker.ru` |
| `DISABLE_SIGNUP` | `true` — аккаунты заводит админ, самозапись клуба не нужна |
| `ENABLE_EMAIL_AUTOCONFIRM` | `true` — почты у операторов рабочие не всегда, письма подтверждения слать некуда |
| `STUDIO_DEFAULT_ORGANIZATION` / `STUDIO_DEFAULT_PROJECT` | `Vyatka Poker Club` / `vyatka` |

## 3. Запуск и схема

```bash
cd /opt/vyatka && docker compose up -d && docker compose ps
```

Когда `supabase-db` здоров:

```bash
./apply-migrations.sh /path/to/vyatka/migrations
```

Скрипт прогоняет `001_init.sql` … `005_player_app.sql` с `ON_ERROR_STOP=1` и
пропускает `002_first_admin.sql` — его правят под свой email и выполняют руками
(шаг 5).

## 4. Домен и TLS

`nginx-vyatka.conf` → `/etc/nginx/sites-available/vyatka`, включить симлинком,
затем:

```bash
certbot --nginx -d api.vyatkapoker.ru && nginx -t && systemctl reload nginx
```

Домен в конфиге уже проставлен. Studio наружу закрыт намеренно: к нему ходят
через туннель.

```bash
ssh -L 3000:localhost:3000 root@<IP VPS>
```

## 5. Первый админ

Заводим пользователя `admin@vyatkapoker.ru` в Studio → Authentication → Users,
заходим им в `/admin` один раз (триггер создаст профиль с ролью `operator`),
потом выполняем `002_first_admin.sql`.

Домен логина зашит в форму входа: `admin` дополняется до `admin@vyatkapoker.ru`,
полный адрес тоже принимается.

## 6. Бот и Mini App

У @BotFather: `/newbot` → токен, затем `/setmenubutton` (или Bot Settings →
Menu Button) → URL **`https://vyatkapoker.ru/`**, без `www` и без пути.
Telegram запоминает домен, а подпись `initData` проверяется на стороне базы —
разъехавшийся адрес ломает вход не при настройке, а у первого игрока.

Токен вставляется последним блоком `005_player_app.sql` (он закомментирован —
раскомментировать и выполнить). Без него `vp_app_login` отвечает
`tg_bot_token_not_configured`.

## 7. Проверка после переезда

Пустая база проверяется ровно одним прогоном — он же первый турнир:

1. `/admin` — вход админом, создание комнаты.
2. `/tournaments` — турнир на сегодня.
3. `/` в Telegram — игрок видит турнир и записывается.
4. В админке «Загрузить список» — записавшийся доехал.
5. `/display?room=…` на ТВ — старт, уровень идёт, дисплей совпадает с админкой.

Если на шаге 3 приложение ругается на `vp_app_*` — не доехал
`005_player_app.sql`. Если на шаге 1 висит 401 — не вставлен `ANON_KEY`.

## 8. Бэкапы

```bash
docker exec supabase-db pg_dump -U postgres -Fc postgres > /var/backups/vyatka-$(date +%F).dump
```

В cron ежедневно, хранить вне сервера. Турнир — это одна строка `rooms.state`:
потерять её посреди вечера значит потерять вечер.
