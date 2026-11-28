#!/bin/sh
set -eu

if [ "${WORKSPACE_DEPLOYMENT_STAGE:-}" != sandbox ]; then
  echo "The Workspace proof image requires the sandbox stage." >&2
  exit 1
fi

if [ "${WORKSPACE_SERVICE_ROLE:-}" = api ]; then
  # Keep the database reachable only from this container. A new instance
  # always starts with a fresh database and a process-local signing key.
  pgdata="$(mktemp -d)"
  initdb -D "$pgdata/data" -U postgres --auth=trust --encoding=UTF8 --no-locale >/dev/null
  pg_ctl -D "$pgdata/data" -l "$pgdata/postgres.log" \
    -o "-h 127.0.0.1 -k $pgdata -p 5432" -w start >/dev/null
  export DATABASE_URL="postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable"
  export DATABASE_URL_UNPOOLED="$DATABASE_URL"
  BETTER_AUTH_SECRETS="1:$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  export BETTER_AUTH_SECRETS

  for migration in /app/migrations/*.sql; do
    PGOPTIONS="-c client_min_messages=warning" \
      psql "$DATABASE_URL" -X -q --single-transaction --set ON_ERROR_STOP=1 --file "$migration" >/dev/null
  done
fi

exec node /app/sandbox.mjs
