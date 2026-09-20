# Разворачивание вятского Supabase

Self-hosted на своём VPS — как у Дойла. Причина та же: облачные адреса из
России душат, а таймер в зале не должен зависеть от настроения магистрали.

Нужно: VPS (2 vCPU / 4 ГБ / 40 ГБ — минимум для полного стека), Docker с
плагином compose, домен вида `api.vyatkapoker.ru` с A-записью на сервер.

## 1. Стек

```bash
git clone --depth 1 https://github.com/supabase/supabase
mkdir -p /opt/vyatka && cp -r supabase/docker/* /opt/vyatka/
cd /opt/vyatka && cp .env.example .env
```

## 2. Ключи

На рабочей машине, из репозитория Вятки:

```bash
node deploy/gen-keys.mjs
```

Пять строк из вывода переносятся в `/opt/vyatka/.env`. `SERVICE_ROLE_KEY`
обходит RLS полностью — он живёт только в `.env` на сервере и, если нужен
локально, в файле вне репозитория.

Там же в `.env` правится:

| Переменная | Значение |
|---|---|
| `API_EXTERNAL_URL`, `SUPABASE_PUBLIC_URL` | `https://api.vyatkapoker.ru` |
| `SITE_URL` | `https://vyatkapoker.ru` — там лежит фронт |
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

Скрипт прогоняет `001_init.sql` с `ON_ERROR_STOP=1` и пропускает
`002_first_admin.sql` — его правят под свой email и выполняют руками.

## 4. Домен и TLS

`nginx-vyatka.conf` → `/etc/nginx/sites-available/vyatka`, включить симлинком,
затем:

```bash
certbot --nginx -d api.vyatkapoker.ru && nginx -t && systemctl reload nginx
```

Studio наружу закрыт намеренно: к нему ходят через туннель.

```bash
ssh -L 3000:localhost:3000 root@<сервер>
```

## 5. Первый админ

Заводим пользователя в Studio → Authentication → Users, заходим им в админку
один раз (триггер создаст профиль с ролью `operator`), потом выполняем
`002_first_admin.sql` со своим адресом.

## 6. Переключение фронта

В [../js/config.js](../js/config.js):

```js
window.SUPABASE_HOSTS = ["https://api.vyatkapoker.ru"];
window.SUPABASE_ANON_KEY = "<ANON_KEY из шага 2>";
window.VP_ROOMS_BRANCH = null;
window.VP_TABLES = { rooms: "rooms", profiles: "profiles", operators: "tournament_operators",
                     tournaments: "tournaments", registrations: "registrations", players: "players" };
```

И домен логина в [../admin.html](../admin.html): `@doyle.ru` → свой.

Выкладка самого фронта описана отдельно — [site.md](site.md): он живёт не на
этом VPS, а на shared-хостинге reg.ru.

Про запасные хосты: у Дойла их три, потому что один адрес периодически
душат. Вятке второй путь тоже понадобится — но заводить его есть смысл
после того, как основной поработает и станет видно, где именно рвётся.

## 7. Бэкапы

```bash
docker exec supabase-db pg_dump -U postgres -Fc postgres > /var/backups/vyatka-$(date +%F).dump
```

В cron ежедневно, хранить вне сервера. Турнир — это одна строка `rooms.state`:
потерять её посреди вечера значит потерять вечер.
