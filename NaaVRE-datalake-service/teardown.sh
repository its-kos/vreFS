#!/bin/bash
# teardown.sh — reset vreFS to a genuinely clean state.
#
# Usage:
#   ./teardown.sh            # containers, volumes, built images (safe default)
#   ./teardown.sh --full      # also removes the conda environment and
#                              # frontend build artifacts (full from-scratch reset)

set -e

FULL=false
if [ "$1" == "--full" ]; then
  FULL=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VREFS_ROOT="${VREFS_ROOT:-$(dirname "$SCRIPT_DIR")}"
SERVICE_DIR="$VREFS_ROOT/NaaVRE-datalake-service"
FRONTEND_DIR="$VREFS_ROOT/NaaVRE-datalake-jupyterlab"

echo "=== Stopping and removing containers + volumes ==="
if [ -d "$SERVICE_DIR" ]; then
  cd "$SERVICE_DIR"
  docker-compose down -v
  echo "  containers and volumes removed"
else
  echo "  skipped: $SERVICE_DIR not found"
fi

echo ""
echo "=== Removing built backend images ==="
IMAGES=$(docker images --format "{{.Repository}}" | grep "naavre-datalake-service" || true)
if [ -n "$IMAGES" ]; then
  echo "$IMAGES" | xargs -I{} docker rmi {} 2>/dev/null || true
  echo "  removed: $IMAGES"
else
  echo "  none found"
fi

if [ "$FULL" = true ]; then
  echo ""
  echo "=== Full reset: removing conda environment ==="
  if conda env list | grep -q "^vrefs "; then
    conda deactivate 2>/dev/null || true
    conda env remove -n vrefs -y
    echo "  conda env 'vrefs' removed"
  else
    echo "  conda env 'vrefs' not found, nothing to remove"
  fi

  echo ""
  echo "=== Full reset: removing frontend build artifacts ==="
  if [ -d "$FRONTEND_DIR" ]; then
    rm -rf "$FRONTEND_DIR/lib" \
           "$FRONTEND_DIR/node_modules" \
           "$FRONTEND_DIR"/NaaVRE_datalake_jupyterlab/labextension
    echo "  removed lib/, node_modules/, and built labextension/"
  else
    echo "  skipped: $FRONTEND_DIR not found"
  fi

  echo ""
  echo "Full reset complete. Re-run start_vrefs.sh from scratch, it will"
  echo "recreate the conda environment and rebuild everything."
else
  echo ""
  echo "Docker state reset. Conda environment and frontend build left"
  echo "intact (run with --full to remove those too)."
  echo "Re-run start_vrefs.sh to bring everything back up."
fi