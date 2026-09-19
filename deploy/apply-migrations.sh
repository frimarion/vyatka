#!/usr/bin/env bash
# Применяет migrations/*.sql по порядку к базе self-hosted Supabase.
# Запускать на сервере, из каталога, где лежит docker-compose Supabase:
#
#   ./apply-migrations.sh /path/to/vyatka/migrations
#
# Идёт через контейнер БД, поэтому пароль наружу не светится и порт 5432
# не нужно открывать в интернет.
set -euo pipefail

MIGRATIONS_DIR="${1:-./migrations}"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "Контейнер '$DB_CONTAINER' не запущен. Задай DB_CONTAINER=<имя>." >&2
  exit 1
fi

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
if [ ${#files[@]} -eq 0 ]; then
  echo "В '$MIGRATIONS_DIR' нет .sql" >&2
  exit 1
fi

for f in "${files[@]}"; do
  case "$(basename "$f")" in
    002_first_admin.sql) echo "→ пропускаю $(basename "$f") (правится вручную под свой email)"; continue ;;
  esac
  echo "→ $(basename "$f")"
  # ON_ERROR_STOP: половина применённой схемы хуже, чем ни одной.
  docker exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$f"
done

echo "Готово."
