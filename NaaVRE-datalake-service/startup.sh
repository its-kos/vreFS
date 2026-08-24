#!/bin/bash
# start_vrefs.sh — bring up the full vreFS local dev environment safely,
# regardless of where the repos are cloned on disk.
#
# Place this script inside one of the four vreFS repos (any one is fine,
# e.g. NaaVRE-datalake-service/start_vrefs.sh) alongside the other three
# as sibling directories, and just run it. It locates the other repos
# relative to its own location automatically. If your layout is
# different, override explicitly:
#
#   VREFS_ROOT=/path/to/parent/dir ./start_vrefs.sh
#
# Handles the known db-readiness race condition: on a fresh volume,
# Postgres/PostGIS can take longer to finish initializing than the
# Django service waits before its first connection attempt, which can
# leave the service process stuck on a stale connection. This script
# waits for a real, verified-healthy database before touching Django
# at all, and only restarts the service if a stale connection is
# actually detected.
#
# Safe to re-run at any time: every step checks current state first
# and skips work that's already done.

set -e

VREFS_ROOT="${VREFS_ROOT:-}"

if [ -z "$VREFS_ROOT" ]; then
  # No override given. Assume this script lives inside one of the four
  # vreFS repos (e.g. NaaVRE-datalake-service/start_vrefs.sh), and that
  # all four repos are siblings under the same parent directory.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  VREFS_ROOT="$(dirname "$SCRIPT_DIR")"
fi

SERVICE_DIR="$VREFS_ROOT/NaaVRE-datalake-service"
STUB_DIR="$VREFS_ROOT/local-communicator-stub"
FRONTEND_DIR="$VREFS_ROOT/NaaVRE-datalake-jupyterlab"
CLIENT_DIR="$VREFS_ROOT/vrefs-client"
DEV_TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJ0ZXN0dXNlciIsImdyb3VwcyI6W119.vMyx0jYENWe-YDHlZir84bxDhcL2Se6y_WQHG3Dvl5c"

echo "Using VREFS_ROOT=$VREFS_ROOT"
if [ ! -d "$SERVICE_DIR" ] && [ ! -d "$FRONTEND_DIR" ]; then
  echo ""
  echo "None of the expected repos were found under: $VREFS_ROOT"
  echo "Either run this script from inside one of the four cloned repos,"
  echo "or set VREFS_ROOT explicitly:  VREFS_ROOT=/path/to/parent ./start_vrefs.sh"
  exit 1
fi

step() { echo ""; echo "=== $1 ==="; }
ok()   { echo "  OK: $1"; }
fail() { echo "  FAILED: $1"; exit 1; }

# ------------------------------------------------------------------
step "1. Conda environment"
# ------------------------------------------------------------------
if [ "$CONDA_DEFAULT_ENV" != "vrefs" ]; then
  echo "  Activating conda env 'vrefs'..."
  # shellcheck disable=SC1091
  source "$(conda info --base)/etc/profile.d/conda.sh"
  conda activate vrefs || fail "conda env 'vrefs' not found. Create it first: conda create -n vrefs python=3.12"
fi
ok "conda env: $CONDA_DEFAULT_ENV"

# ------------------------------------------------------------------
step "2. Backend containers"
# ------------------------------------------------------------------
cd "$SERVICE_DIR" || fail "cannot find $SERVICE_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env from .env.example"
fi

docker-compose up -d
ok "docker-compose up issued"

# ------------------------------------------------------------------
step "3. Wait for a genuinely ready database (not just 'Up')"
# ------------------------------------------------------------------
echo "  Waiting for Postgres to accept real connections..."
MAX_WAIT=60
WAITED=0
until docker-compose exec -T db pg_isready -U vrefs > /dev/null 2>&1; do
  sleep 2
  WAITED=$((WAITED + 2))
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    fail "db did not become ready within ${MAX_WAIT}s. Check: docker-compose logs db"
  fi
done
ok "db is accepting connections (waited ${WAITED}s)"

# ------------------------------------------------------------------
step "4. Run migrations"
# ------------------------------------------------------------------
# On a genuinely fresh volume, Postgres's own entrypoint starts a
# temporary internal server just to run init scripts (loading PostGIS
# extensions), then shuts it down and starts the real, final server.
# pg_isready can report "ready" during that brief temporary window,
# right before the shutdown-and-restart happens, so migrate can still
# hit "Connection refused" even after step 3 passed. Retrying migrate
# itself, rather than trusting the readiness check alone, is the
# actual fix.
MIGRATE_ATTEMPTS=6
MIGRATE_WAIT=5
for i in $(seq 1 $MIGRATE_ATTEMPTS); do
  if docker-compose exec -T service python manage.py migrate 2>/tmp/vrefs_migrate.log; then
    ok "migrations applied (attempt $i)"
    break
  fi
  if [ "$i" -eq "$MIGRATE_ATTEMPTS" ]; then
    cat /tmp/vrefs_migrate.log
    fail "migrate failed after $MIGRATE_ATTEMPTS attempts, see output above"
  fi
  echo "  migrate failed on attempt $i (likely db still finishing its restart cycle), retrying in ${MIGRATE_WAIT}s..."
  sleep $MIGRATE_WAIT
done

# ------------------------------------------------------------------
step "5. Verify the API actually responds"
# ------------------------------------------------------------------
STATUS=$(curl -s -o /tmp/vrefs_health.json -w "%{http_code}" \
  --max-time 10 \
  http://localhost:8000/api/v1/datasets/ \
  -H "Authorization: Bearer $DEV_TOKEN" || echo "000")

if [ "$STATUS" == "200" ]; then
  ok "API responded 200"
else
  echo "  API returned status: $STATUS (expected 200)"
  echo "  This usually means the service container is stuck on a stale"
  echo "  connection from before the database was ready. Restarting it..."
  docker-compose restart service
  sleep 5
  STATUS=$(curl -s -o /tmp/vrefs_health.json -w "%{http_code}" \
    --max-time 10 \
    http://localhost:8000/api/v1/datasets/ \
    -H "Authorization: Bearer $DEV_TOKEN" || echo "000")
  if [ "$STATUS" == "200" ]; then
    ok "API responded 200 after restarting service"
  else
    fail "API still not responding after restart (status: $STATUS). Check: docker-compose logs service"
  fi
fi

# ------------------------------------------------------------------
step "6. Communicator stub (required — panel auth depends on this)"
# ------------------------------------------------------------------
if [ -d "$STUB_DIR" ]; then
  if jupyter server extension list 2>&1 | grep -q "local_communicator_stub.*OK"; then
    ok "local_communicator_stub already enabled"
  else
    echo "  Installing local_communicator_stub..."
    (cd "$STUB_DIR" && pip install -e . > /dev/null) || fail "pip install failed for communicator stub"
    jupyter server extension enable local_communicator_stub
    if jupyter server extension list 2>&1 | grep -q "local_communicator_stub.*OK"; then
      ok "local_communicator_stub installed and enabled"
    else
      fail "communicator stub still not showing as enabled, check manually: jupyter server extension list"
    fi
  fi
else
  echo "  Skipping: $STUB_DIR not found"
fi

# ------------------------------------------------------------------
step "7. Frontend extension"
# ------------------------------------------------------------------
if [ -d "$FRONTEND_DIR" ]; then
  if jupyter labextension list 2>&1 | grep -qi "vrefs.*OK\|datalake.*OK"; then
    ok "frontend extension already enabled"
  else
    echo "  Building and linking frontend extension (this may take a minute)..."
    (
      cd "$FRONTEND_DIR"
      jlpm install
      jlpm run build
      pip install -e .
      jupyter labextension develop --overwrite .
    ) || fail "frontend build/install failed"
    ok "frontend extension built and linked"
  fi
else
  echo "  Skipping: $FRONTEND_DIR not found"
fi

# ------------------------------------------------------------------
step "8. vrefs notebook client"
# ------------------------------------------------------------------
if [ -d "$CLIENT_DIR" ]; then
  if python3 -c "import vrefs" > /dev/null 2>&1; then
    ok "vrefs client already installed"
  else
    (cd "$CLIENT_DIR" && pip install -e . > /dev/null) || fail "pip install failed for vrefs client"
    ok "vrefs client installed"
  fi
else
  echo "  Skipping: $CLIENT_DIR not found"
fi

# ------------------------------------------------------------------
step "9. Launch JupyterLab"
# ------------------------------------------------------------------
# The extension was already fully built and linked in step 7
# (jlpm run build + jupyter labextension develop --overwrite .), so
# there's nothing left to watch or recompile for normal use. Just
# launch JupyterLab directly, in this same already-activated conda
# environment.
#
# If you're actively editing the frontend TypeScript source and want
# it to auto-recompile on save, run this in a separate terminal
# first (with `conda activate vrefs` and `cd` into the frontend repo):
#   jlpm run watch

if [ -d "$FRONTEND_DIR" ]; then
  echo "  Launching JupyterLab. Press Ctrl+C here to stop it when you're done."
  echo ""
  cd "$FRONTEND_DIR"
  jupyter lab
else
  echo "  Skipping: $FRONTEND_DIR not found, nothing to launch."
fi