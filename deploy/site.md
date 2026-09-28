# Выкладка сайта: vyatkapoker.ru

Фронт — статика без сборки, живёт на shared-хостинге reg.ru (Host-0), отдельно
от Supabase: базе нужен свой VPS с докером, сайту достаточно каталога с файлами.

Доменов два, оба ведут в один и тот же каталог: **vyatkapoker.ru** — основной,
**vyatkapoker.online** редиректом на него (`.htaccess`). Ссылка на дисплей
набирается на ТВ руками — адрес должен быть один.

Выкладывает [GitHub Actions](../.github/workflows/deploy.yml): пуш в `main` →
тесты ядра → `rsync` каталога сайта на хостинг. Руками по FTP ничего не кладём:
иначе следующая выкладка молча затрёт правку (`rsync --delete`).

## 1. Домены в панели reg.ru

Хостинг → карточка услуги → **Сайты**:

- `vyatkapoker.online` уже заведён — запомни путь к его каталогу
  (вида `/var/www/uXXXXXXX/data/www/vyatkapoker.online`), он пойдёт в секрет.
- `vyatkapoker.ru` добавь **алиасом/доменом к тому же сайту**, а не вторым
  сайтом: два каталога — это две копии, которые разъедутся.
- У обоих включи бесплатный SSL (Let's Encrypt), иначе редирект на https
  упрётся в ошибку сертификата.

DNS: A-записи обоих доменов на IP хостинга (если домены в reg.ru — панель
проставит сама).

Хостинг: reg.ru Host-0, панель ispmanager на `https://server40.hosting.reg.ru:1500/`,
пользователь `u3653852`, домашний каталог `/var/www/u3653852/data`.

## 2. Ключ для выкладки

На рабочей машине:

```bash
ssh-keygen -t ed25519 -C "github-actions vyatkapoker" -f ~/.ssh/vyatka_deploy -N ""
```

Раздела SSH-ключей у reg.ru на шареде нет, а `ssh-copy-id` не годится: SSH там
не OpenSSH, а **dropbear**, и ключ он пытается положить в `/etc/dropbear/`, куда
прав нет. Кладём в свой домашний каталог руками (пароль спросит один раз):

```bash
ssh u3653852@server40.hosting.reg.ru 'mkdir -p ~/.ssh && chmod 700 ~/.ssh \
  && printf "%s\n" "<содержимое vyatka_deploy.pub>" >> ~/.ssh/authorized_keys \
  && chmod 600 ~/.ssh/authorized_keys'
```

Проверить, что пускает без пароля, и снять отпечаток сервера:

```bash
ssh -i ~/.ssh/vyatka_deploy -o IdentitiesOnly=yes u3653852@server40.hosting.reg.ru "pwd && ls www"
ssh-keyscan server40.hosting.reg.ru
```

Приватный ключ никуда, кроме секрета GitHub, не копируем — он даёт доступ
ко всему аккаунту хостинга, а не только к каталогу сайта.

## 3. Секреты репозитория

`Settings → Secrets and variables → Actions` в
[frimarion/vyatka](https://github.com/frimarion/vyatka):

| Секрет | Значение |
|---|---|
| `DEPLOY_HOST` | сервер из раздела «Доступы», вида `sXX.hosting.reg.ru` |
| `DEPLOY_USER` | пользователь вида `uXXXXXXX` |
| `DEPLOY_SSH_KEY` | содержимое `~/.ssh/vyatka_deploy` целиком, с обеими строками BEGIN/END |
| `DEPLOY_KNOWN_HOSTS` | вывод `ssh-keyscan` из шага 2 |
| `DEPLOY_PATH` | каталог сайта, без слеша на конце |

Порт SSH, если не 22, — переменной `DEPLOY_PORT` (вкладка Variables).

Секреты `production`-окружения: workflow объявляет `environment: production`,
так что при желании там же включается ручное подтверждение выкладки.

## 4. Первая выкладка

```bash
git push origin main
```

Либо вручную: вкладка **Actions** → workflow `deploy` → **Run workflow**.
Последним шагом job проверяет, что `https://vyatkapoker.ru/` отвечает 200 —
красный крестик там означает, что файлы уехали, но домен/SSL ещё не настроен.

## 5. Если на тарифе нет rsync

Шаг «rsync на хостинг» меняется на зеркалирование по SFTP:

```yaml
      - name: lftp на хостинг
        run: |
          sudo apt-get update && sudo apt-get install -y lftp
          lftp -c "set sftp:connect-program 'ssh -i $HOME/.ssh/id_deploy -p ${{ vars.DEPLOY_PORT || 22 }}';
                   open sftp://${{ secrets.DEPLOY_USER }}@${{ secrets.DEPLOY_HOST }};
                   mirror -R --delete --verbose dist/ ${{ secrets.DEPLOY_PATH }}/"
```

`mirror -R --delete` делает то же самое, что `rsync --delete`, только медленнее:
сравнивает по размеру и времени, а не по контрольной сумме.

## 6. Что лежит в вебруте

`index.html`, `admin.html`, `display.html`, `css/`, `js/`, `lib/` и
[`htaccess`](htaccess) под именем `.htaccess`. Миграции, тесты и этот рунбук
на хостинг не уезжают — в `deploy.yml` каталог собирается списком, а не
копированием репозитория целиком.

`.htaccess` заодно даёт короткие адреса: `/admin` и `/display` работают без
`.html`. Ссылка на ТВ выглядит как `https://vyatkapoker.ru/display?room=ABC123`.
Старые адреса с `.html` сервер уводит на чистые (302, query сохраняется),
поэтому в коде ссылки остаются с `.html` — так их понимает и локальный
`python -m http.server`, которому `.htaccess` неведом.

Про редирект на https: внутри `.htaccess` смотрим на `X-Forwarded-Proto`, а не
на `%{HTTPS}`. TLS терминирует nginx перед Apache, поэтому для Apache соединение
всегда «не защищено» — по `%{HTTPS}` сайт редиректил сам на себя и падал в
ERR_TOO_MANY_REDIRECTS.

## 6a. SSL

ispmanager → **SSL-сертификаты** → «Добавить сертификат» → Let's Encrypt, домены
`vyatkapoker.ru www.vyatkapoker.ru`, почтовый ящик — реальный, на него приходят
напоминания об истечении. Самоподписанный, который панель заводит сама, браузер
покажет как «Подключение не защищено», и выкладка это поймает: последний шаг
workflow проверяет домен настоящим curl.

## 7. Бэкенд

Сайт пока ходит в дойловскую инсталляцию Supabase — переезд на свою описан
в [README.md](README.md). Когда база переедет, в
[../js/config.js](../js/config.js) меняются хосты и таблицы; сайт при этом
остаётся там же, выкладка не меняется.
