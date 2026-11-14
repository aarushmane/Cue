#!/usr/bin/env bash
# Applies every migration + the seed to a throwaway Postgres and runs supabase/tests/*.test.sql.
# Usage: npm run test:db
#   Default: Docker (container "sg-pg-test" on port 55433, removed afterwards).
#   Without Docker: TEST_DB_URL=postgres://postgres@localhost:55433/postgres npm run test:db
#     uses an existing Postgres 16 server; a scratch database "sg_db_test" is dropped and recreated there.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${TEST_DB_URL:-}" ]]; then
  command psql "$TEST_DB_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists sg_db_test" -c "create database sg_db_test"
  DB_URL="${TEST_DB_URL%/*}/sg_db_test"
  psql() { command psql "$DB_URL" -v ON_ERROR_STOP=1 -q "$@"; }
else
  NAME=sg-pg-test
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=pw -p 55433:5432 postgres:16-alpine >/dev/null
  trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres -q && break; sleep 1; done
  sleep 1
  psql() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
fi

psql < supabase/tests/stubs.sql
for f in supabase/migrations/*.sql supabase/seed.sql; do
  echo "apply $f"
  psql < "$f"
done
for t in supabase/tests/*.test.sql; do
  echo "test $t"
  psql -o /dev/null < "$t" 2>&1 | sed "s/^NOTICE:  /  /"
done
echo "db tests passed"
