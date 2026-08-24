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
S3_BUCKET="exp1-test-bucket"                       # created automatically below if missing

echo "=== Ensuring S3 test bucket and test files exist ==="
python3 -c "import boto3" 2>/dev/null || pip install boto3 --quiet

python3 - <<PYEOF
import boto3
import io

s3 = boto3.client(
    "s3",
    endpoint_url="http://localhost:9000",
    aws_access_key_id="minioadmin",
    aws_secret_access_key="minioadmin",
)

bucket = "$S3_BUCKET"

existing = [b["Name"] for b in s3.list_buckets().get("Buckets", [])]
if bucket not in existing:
    s3.create_bucket(Bucket=bucket)
    print(f"  Created bucket: {bucket}")
else:
    print(f"  Bucket already exists: {bucket}")

objects = s3.list_objects_v2(Bucket=bucket).get("Contents", [])
if not objects:
    s3.put_object(Bucket=bucket, Key="sample1.csv", Body=b"a,b,c\n1,2,3\n4,5,6\n")
    s3.put_object(Bucket=bucket, Key="sample2.txt", Body=b"Test file for vreFS registration testing.\n")
    print("  Uploaded 2 test files (sample1.csv, sample2.txt)")
else:
    print(f"  Bucket already has {len(objects)} object(s), leaving as is")
PYEOF
echo ""

register_and_index() {
  local NAME=$1
  local TYPE=$2
  local EXTRA=$3

  echo "=== Registering $NAME ($TYPE) ==="

  RESPONSE=$(curl -s --max-time 15 -X POST "$API/storage-backends/" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$NAME\", \"backend_type\": \"$TYPE\", $EXTRA}" || echo '{"__curl_failed__": true}')

  BACKEND_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1]).get('id',''))" "$RESPONSE" 2>/dev/null)

  if [ -z "$BACKEND_ID" ]; then
    echo "  Registration failed or timed out: $RESPONSE"
    return
  fi
  echo "  backend_id=$BACKEND_ID"

  INDEX_RESULT=$(curl -s --max-time 30 -X POST "$API/storage-backends/$BACKEND_ID/index/" \
    -H "Authorization: Bearer $TOKEN" || echo '{"__curl_failed__": true}')
  echo "  $INDEX_RESULT"

  sleep 2
  DATASETS=$(curl -s --max-time 15 "$API/datasets/?backend=$BACKEND_ID" -H "Authorization: Bearer $TOKEN" || echo '{"__curl_failed__": true}')
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