#!/bin/sh
# Container entrypoint.
#
# Normal operation: exec the API so it is PID 1 and receives signals directly.
#
# Set DEBUG_HOLD=1 in the environment to instead run the app as a child, print
# its exit code, and park the container so `docker exec` still works. Without
# that, a boot failure makes the task exit and Swarm reaps it, leaving no way
# to read the stack trace. Toggling this is an env change plus a restart — it
# does not require rebuilding the image.

set -u

if [ "${DEBUG_HOLD:-0}" = "1" ]; then
  echo "=== DEBUG_HOLD=1 — container will stay up after the app exits ==="
  echo "--- env sanity (secrets shown as lengths only) ---"
  echo "NODE_ENV=${NODE_ENV:-<unset>}  PORT=${PORT:-<unset>}  API_PREFIX=${API_PREFIX:-<unset>}"
  echo "DB_HOST=${DB_HOST:-<unset>}  DB_PORT=${DB_PORT:-<unset>}  DB_NAME=${DB_NAME:-<unset>}  DB_USER=${DB_USER:-<unset>}"
  echo "DB_PASSWORD len=$(printf %s "${DB_PASSWORD:-}" | wc -c)"
  echo "REDIS_HOST=${REDIS_HOST:-<unset>}  REDIS_PORT=${REDIS_PORT:-<unset>}  REDIS_PASSWORD len=$(printf %s "${REDIS_PASSWORD:-}" | wc -c)"
  echo "JWT_ACCESS_SECRET len=$(printf %s "${JWT_ACCESS_SECRET:-}" | wc -c)  JWT_REFRESH_SECRET len=$(printf %s "${JWT_REFRESH_SECRET:-}" | wc -c)"
  echo "pg driver present: $([ -f /app/node_modules/pg/package.json ] && echo yes || echo NO)"
  echo "--- starting app ---"

  node dist/main.js
  code=$?
  echo "=== APP EXITED code=${code} — container parked (DEBUG_HOLD=1) ==="
  exec sleep infinity
fi

# One-shot database bootstrap, for a fresh database that has no tables yet.
# Set DB_BOOTSTRAP=1 in the environment and redeploy: the container creates the
# schema (safe sync — it never drops or alters existing tables) and seeds the
# catalogue, then starts normally. Set it back to 0 afterwards so a restart does
# not repeat the work. Failures are logged but do not stop the API booting.
if [ "${DB_BOOTSTRAP:-0}" = "1" ]; then
  echo "=== DB_BOOTSTRAP=1 — creating schema ==="
  node dist/scripts/sync-db.js || echo "!!! sync-db failed (see error above)"
  echo "=== DB_BOOTSTRAP=1 — seeding catalogue ==="
  node dist/scripts/seed.js || echo "!!! seed failed (see error above)"
  echo "=== bootstrap done — set DB_BOOTSTRAP=0 and redeploy ==="
fi

exec node dist/main.js
