# Разворачивание на vyatkapoker.ru

Два адреса и две машины — это не усложнение, а разделение по требованиям:

| Что | Где | Почему там |
|---|---|---|
| `vyatkapoker.ru` — фронт | shared-хостинг reg.ru (Host-0) | Статика без сборки. 400 КБ HTML на 13 ГБ тарифа, PHP и MySQL не нужны вовсе. |
| `api.vyatkapoker.ru` — Supabase | Timeweb VPS `176.57.214.63` | Self-hosted Supabase — это Docker-стек из десятка контейнеров. На shared-хостинге Docker'а нет, поэтому бэкенд физически не может жить рядом с фронтом. |

Сервер: Premium 2 × 3.3 ГГц, 4 ГБ RAM, 50 ГБ NVMe, Ubuntu 24.04. Размер взят
не с потолка: боевой бэкенд Дойла — тот же стек из 13 контейнеров — живёт на
1 ядре и 2 ГБ, и там постоянно занято больше гигабайта свопа. Вдвое больше
памяти убирает своп, вдвое больше ядер — запас на docker compose и миграции.
Дальше расти незачем: сама база клуба весит десятки мегабайт, место на диске
съедают образы Docker, а не данные.

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
| `api` | A | `176.57.214.63` |

Домен в панели хостинга надо ещё и **привязать к сайту** (Хостинг → Сайты →
Добавить сайт), иначе A-запись доедет, а Apache отдаст заглушку.

Пока `api` не резолвится, certbot на шаге 4 выдаст ошибку — это нормально,
DNS расходится до получаса. Проверить: `nslookup api.vyatkapoker.ru`.

**Перед certbot убедись, что зона согласована на всех NS.** Одного успешного
`nslookup` мало: у reg.ru зона обслуживается `ns1`/`ns2.hosting.reg.ru`, и при
разворачивании Вятки они больше часа отдавали разные версии — запись была на
одном сервере и отсутствовала на другом, при этом каждый отвечал авторитетно.
Let's Encrypt проверяет домен с нескольких точек, попадал на отставший сервер и
отказывал. Две попытки выпуска ушли впустую, а неудачных проверок разрешено
пять в час на домен — упереться в лимит легко.

Проба, которая это ловит (запускать с сервера, где есть `dig`):

```bash
for ns in ns1.hosting.reg.ru ns2.hosting.reg.ru; do
  ok=0; for i in $(seq 1 15); do
    [ -n "$(dig +short +time=5 +tries=1 A api.vyatkapoker.ru @$ns)" ] && ok=$((ok+1))
  done; echo "$ns: $ok/15"
done
```

Запускать certbot только при `15/15` на обоих. Полезно и сравнить SOA serial:
`dig +short SOA vyatkapoker.ru @ns1...` против `@ns2...` — расхождение серийников
и есть та самая рассинхронизация. Лечится обращением в поддержку reg.ru;
добавление любой новой записи поднимает serial и иногда подталкивает синхронизацию.

Отдельно про кэш: после неудачных попыток резолверы запоминают `NXDOMAIN`.
Негативный TTL в этой зоне — час (`min` от TTL записи SOA и её `minimum`), так
что даже после починки имя ещё какое-то время не резолвится. Сервер при этом
проверяется в обход DNS:

```bash
curl --resolve api.vyatkapoker.ru:443:127.0.0.1 https://api.vyatkapoker.ru/auth/v1/settings -H "apikey: <ANON_KEY>"
```

## 1. Фронт на Host-0

Выкладывается сам: пуш в `main` → GitHub Actions прогоняет тесты ядра и катит
каталог сайта на хостинг по `rsync`. Подробности, домены и секреты —
[site.md](site.md). Руками по FTP ничего не кладём: следующая выкладка молча
затрёт правку, потому что `rsync` идёт с `--delete`.

Что уезжает в вебрут (шаг «Собрать каталог сайта» в
[../.github/workflows/deploy.yml](../.github/workflows/deploy.yml)):

| Адрес | Файл |
|---|---|
| `vyatkapoker.ru/` | `index.html` — приложение игрока, он же Mini App |
| `/admin` | `admin.html` |
| `/tournaments` | `tournaments.html` |
| `/crm` | `crm.html` |
| `/display?room=…` | `display.html` — ссылка для ТВ |
| `/start` | `start.html` — служебный хаб со ссылками |

Плюс `css/`, `js/`, `lib/`, `assets/` и `deploy/htaccess` под именем `.htaccess`.
Короткие адреса делает он же — общим правилом «нет файла, но есть `.html`».

Миграции, рунбуки и тесты на хостинг не уезжают вовсе: список файлов в сборке
явный. Добавил страницу в репозиторий — добавь её и туда, иначе на домене её
просто не будет.

## 2. VPS: подготовка, стек и ключи

На чистой Ubuntu Docker'а нет, а свопа у Timeweb нет тоже. Своп нужен: у Дойла
на таком же стеке постоянно занято больше гигабайта, и без свопа всплеск памяти
превращается не в замедление, а в OOM-killer, который гасит контейнер посреди
вечера.

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

apt-get update && apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

```bash
git clone --depth 1 https://github.com/supabase/supabase
mkdir -p /opt/vyatka && cp -r supabase/docker/* /opt/vyatka/
cd /opt/vyatka && cp .env.example .env
```

### Порты: дефолтный compose смотрит наружу

Это первое, что надо поправить, и до `up -d`. В `docker-compose.yml` проброски
висят на всех интерфейсах, то есть **Postgres и API-шлюз доступны из интернета**
напрямую, в обход nginx и TLS:

```
- ${API_GW_HTTP_PORT:-${KONG_HTTP_PORT:-8000}}:8000/tcp
- ${POSTGRES_PORT}:5432
- ${POOLER_PROXY_PORT_TRANSACTION}:6543
```

Каждую надо привязать к петле, дописав `127.0.0.1:` перед значением. Править
именно проброски, а не переменные: `POSTGRES_PORT` подставляется ещё в десяток
строк подключения (`GOTRUE_DB_DATABASE_URL`, `PGRST_DB_URI` и прочие), и адрес
в ней всё там сломает.

Сверху — файрвол, наружу только SSH и HTTP(S):

```bash
apt-get install -y ufw
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
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
| `SUPABASE_PUBLIC_URL` | `https://api.vyatkapoker.ru` |
| `API_EXTERNAL_URL` | `https://api.vyatkapoker.ru/auth/v1` — **с суффиксом**: в текущей версии это полный адрес сервиса Auth, а не базовый |
| `SITE_URL` | `https://vyatkapoker.ru` |
| `SECRET_KEY_BASE`, `VAULT_ENC_KEY` | свои случайные (в примере лежат общеизвестные значения из репозитория); `VAULT_ENC_KEY` — ровно 32 символа |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | логин в Studio; дефолтный пароль в примере так и называется `this_password_is_insecure_and_should_be_updated` |
| `DISABLE_SIGNUP` | `false` — **см. шаг 7**: почтовый вход игрока заводит ему аккаунт в GoTrue, иначе некому отправить код |
| `ENABLE_EMAIL_AUTOCONFIRM` | `false` — **см. шаг 7**: при `true` GoTrue подтверждает адрес сам и кода не шлёт |
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
ssh -L 3000:localhost:3000 root@176.57.214.63
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

## 7. Вход игроков: VK и почта

Два основных способа входа (третий — телеграмный из шага 6). Оба включаются
миграцией `006_auth_vk_email.sql` и двумя секретами; пока секретов нет,
приложение честно пишет «вход пока не настроен».

### VK ID

Приложение клуба заведено на [id.vk.com](https://id.vk.com/) → «Мои приложения»,
**id `54782171`**. Два поля в кабинете, из-за которых вход ломается чаще всего:

| Поле в кабинете VK | Значение |
|---|---|
| Базовый домен | `vyatkapoker.ru` |
| Доверенный redirect URL | `https://vyatkapoker.ru/` — со слэшем, без пути |

`redirectUrl` SDK собирает из `location.origin + location.pathname`, то есть
для корня домена это ровно `https://vyatkapoker.ru/`. Не совпало — VK
показывает свою ошибку ещё до того, как запрос дойдёт до нас.

ID приложения лежит **в двух местах**, и они должны совпадать:

1. `window.VP_VKID_APP` в [js/config.js](../js/config.js) — им SDK рисует кнопку;
2. `app_secrets('vk_client_id')` — с ним сервер спрашивает у VK, чей это токен.

Разъехались — вход отвечает `auth_token_invalid`, и со стороны это выглядит
как «VK сломался». Секрет приложения VK не нужен нигде: обмен кода идёт по
PKCE в браузере, а сервер проверяет уже выданный токен.

Виджет — `OneTap` с `showAlternativeLogin` и альтернативами `mail_ru`/`ok_ru`,
как в сниппете из кабинета: залогиненному в VK это один тап, а Mail.ru и
Одноклассники — те же аккаунты VK ID, отдельного способа входа они не заводят.

Проверка VK-токена — единственный исходящий запрос из базы, он ходит через
расширение `http`:

```bash
docker exec supabase-db psql -U postgres -d postgres -c "select 1 from pg_available_extensions where name='http'"
```

Пусто — миграция не применится и честно об этом скажет; лечится образом
`supabase/postgres` посвежее.

### Почта

Код из письма шлёт GoTrue — значит ему нужен работающий SMTP. В `/opt/vyatka/.env`:

| Переменная | Значение |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` | сервер почты клуба (reg.ru, Яндекс 360 — что заведено под доменом) |
| `SMTP_USER` / `SMTP_PASS` | ящик, от которого уходят письма |
| `SMTP_ADMIN_EMAIL` / `SMTP_SENDER_NAME` | `noreply@vyatkapoker.ru`, «Вятка» |
| `ENABLE_EMAIL_AUTOCONFIRM` | **`false`** |
| `DISABLE_SIGNUP` | **`false`** |
| `MAILER_OTP_EXP` | `600` — десять минут на шесть цифр |

Оба переключателя в шаге 2 стояли наоборот, и оба меняются именно здесь:

- `ENABLE_EMAIL_AUTOCONFIRM=true` подтверждает адрес сам и кода не шлёт — с ним
  почтовый вход не работает вовсе. Операторов после переключения по-прежнему
  заводит админ в Studio, там подтверждение ставится галочкой.
- `DISABLE_SIGNUP=true` не даёт завести аккаунт новому адресу — то есть новый
  игрок кода не получит. Открывать самозапись было бы страшно, пока «свой»
  значило «залогинен»; `006_auth_vk_email.sql` это чинит (см. ниже).

**Что делает 006 с правами, и почему без этого нельзя.** Аккаунт в GoTrue
появляется у каждого игрока, вошедшего по почте. А политики 001 и 004 писались,
когда аккаунт был только у персонала, и «свой» в них записан как
`auth.uid() is not null`. Без правки первый же игрок с почтой получал бы
телефоны всех игроков клуба и денежные отчёты CRM, а триггер
`on_auth_user_created` заводил бы ему профиль с ролью `operator`. После
миграции:

- профиль заводится только адресу `@vyatkapoker.ru` — операторов заводит админ,
  и домен у них всегда клубный (форма входа в админке сама его дописывает);
- «свой» в политиках `players`, `tournament_results`, `tournament_result_players`
  и макетов — это `public.is_staff()`, то есть «есть строка в `profiles`»;
- комнаты, расписание, записи и назначения операторов не трогались: там «свой»
  с самого начала проверяется через `is_admin()` и `can_access_*`.

Проверить после применения — под аккаунтом игрока (не оператора) чтение игроков
должно вернуть пусто, а не список клуба.

Письмо шлётся шаблоном «Magic Link», а нужен в нём именно код — в Studio →
Authentication → Email Templates у шаблона должен быть `{{ .Token }}`
(а не `{{ .ConfirmationURL }}`), иначе игроку придёт ссылка, которую некуда
ввести.

### Секреты

Последний блок `006_auth_vk_email.sql` — закомментирован, раскомментировать
и выполнить, подставив своё:

```sql
insert into public.app_secrets (key, value) values
  ('vk_client_id', '54782171'),
  ('jwt_secret',   '<JWT_SECRET из /opt/vyatka/.env>')
on conflict (key) do update set value = excluded.value;
```

`jwt_secret` — тот самый, которым подписан `ANON_KEY`. Им же GoTrue подписывает
токены игроков, и именно его сверяет база, принимая почтовый вход: своё же
письмо, свой же ключ, чужому токену внутрь не пролезть.

## 8. Проверка после переезда

Пустая база проверяется ровно одним прогоном — он же первый турнир:

1. `/admin` — вход админом, создание комнаты.
2. `/tournaments` — турнир на сегодня.
3. `/` в Telegram — игрок видит турнир и записывается.
4. В админке «Загрузить список» — записавшийся доехал.
5. `/display?room=…` на ТВ — старт, уровень идёт, дисплей совпадает с админкой.

Если на шаге 3 приложение ругается на `vp_app_*` — не доехал
`005_player_app.sql`. Если на шаге 1 висит 401 — не вставлен `ANON_KEY`.

## 8. Бэкапы

Стоит на сервере: `/usr/local/bin/vyatka-backup.sh` по крону из
`/etc/cron.d/vyatka-backup`, каждый день в 05:20 — заведомо после последнего
турнира и до любого утреннего вмешательства.

```bash
docker exec supabase-db pg_dump -U postgres -Fc postgres > /var/backups/vyatka/vyatka-$(date +%F).dump
find /var/backups/vyatka -name 'vyatka-*.dump' -mtime +14 -delete
```

Хранится две недели: база весит сотни килобайт, диска не жалко, а «заметили
через неделю» — реальный срок для клубной ошибки. Проверить, что дамп живой,
не разворачивая его:

```bash
docker exec -i supabase-db pg_restore -l < /var/backups/vyatka/vyatka-<дата>.dump | head
```

**Дампы лежат на том же сервере, что и база.** От испорченной миграции или
удалённой строки это спасает, от потери самой машины — нет. Нужен либо слот
бэкапов у Timeweb (снимок всей VM), либо выгрузка дампов наружу. Турнир — это
одна строка `rooms.state`: потерять её посреди вечера значит потерять вечер.
