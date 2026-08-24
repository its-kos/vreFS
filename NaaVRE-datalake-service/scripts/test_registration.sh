#!/bin/bash
# test_registration.sh — register a backend of each implemented type
# and verify indexing/FAIR scoring works end to end.
#
# Prerequisites: backend running (docker-compose up), at least one
# test bucket/repo/folder already prepared for whichever backend you
# want to test. Edit the variables below to match your test data.

set -e

API="http://localhost:8000/api/v1"
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJwcmVmZXJyZWRfdXNlcm5hbWUiOiJ0ZXN0dXNlciIsImdyb3VwcyI6W119.vMyx0jYENWe-YDHlZir84bxDhcL2Se6y_WQHG3Dvl5c"

# --- Edit these to match your test data ---
LOCAL_PATH="$HOME/vrefs-test/local-backend"      # a folder with a couple of files
GITHUB_REPO="https://github.com/its-kos/vreFS"    # any public repo with files
GITHUB_BRANCH="main"
S3_BUCKET="exp1-test-bucket"                       # a bucket already populated in MinIO

register_and_index() {
  local NAME=$1
  local TYPE=$2
  local EXTRA=$3

  echo "=== Registering $NAME ($TYPE) ==="

  RESPONSE=$(curl -s -X POST "$API/storage-backends/" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$NAME\", \"backend_type\": \"$TYPE\", $EXTRA}")

  BACKEND_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$RESPONSE" 2>/dev/null)

  if [ -z "$BACKEND_ID" ]; then
    echo "  Registration failed: $RESPONSE"
    return
  fi
  echo "  backend_id=$BACKEND_ID"

  INDEX_RESULT=$(curl -s -X POST "$API/storage-backends/$BACKEND_ID/index/" \
    -H "Authorization: Bearer $TOKEN")
  echo "  $INDEX_RESULT"

  sleep 2
  DATASETS=$(curl -s "$API/datasets/?backend=$BACKEND_ID" -H "Authorization: Bearer $TOKEN")
  echo "  datasets: $DATASETS" | head -c 400
  echo ""
  echo ""
}

# Local (indexing happens client-side via the extension in real use;
# via API this will register the backend but won't auto-index, that's
# expected — see thesis Design/Backend Abstraction for why)
register_and_index "test-local" "local" \
  "\"root_path\": \"$LOCAL_PATH\", \"credentials\": {\"provider\": \"none\"}"

# GitHub
register_and_index "test-github" "github" \
  "\"endpoint_url\": \"$GITHUB_REPO\", \"root_path\": \"$GITHUB_BRANCH\", \"credentials\": {\"provider\": \"none\"}"

# S3 / MinIO
register_and_index "test-s3" "s3" \
  "\"endpoint_url\": \"http://minio:9000\", \"root_path\": \"$S3_BUCKET\", \"credentials\": {\"provider\": \"env\", \"vars\": {\"access_key\": \"VREFS_MINIO_ACCESS_KEY\", \"secret_key\": \"VREFS_MINIO_SECRET_KEY\"}}}"

echo "Done. Review each backend's dataset output above."