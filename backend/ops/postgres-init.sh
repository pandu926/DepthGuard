#!/usr/bin/env bash
set -euo pipefail
# A dedicated runtime role receives DML grants during migrations, never superuser privileges.
if [[ ! ${APP_DB_PASSWORD:-} =~ ^[a-f0-9]{64}$ ]]; then
  printf '%s\n' 'APP_DB_PASSWORD must contain 32 random bytes encoded as hex' >&2
  exit 1
fi
printf "CREATE ROLE depthguard_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '%s';\n" "$APP_DB_PASSWORD" |
  psql --no-psqlrc --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"
