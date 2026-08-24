#!/bin/bash
# test_collaboration.sh — full publish/discover/subscribe/import flow
# between two simulated researcher identities. Mirrors exactly what
# was manually verified during thesis testing (Experiment 2).
#
# Prerequisites: backend running, an S3/MinIO bucket already populated
# with at least one test file (see S3_BUCKET below).

set -e

API="http://localhost:8000/api/v1"
S3_BUCKET="exp1-test-bucket"

echo "=== Generating two researcher identities ==="
TOKENS=$(python3 - <<'EOF'
import jwt
alice = jwt.encode({"sub": "test-alice", "preferred_username": "alice"}, "fake-secret", algorithm="HS256")
bob = jwt.encode({"sub": "test-bob", "preferred_username": "bob"}, "fake-secret", algorithm="HS256")
print(alice)
print(bob)
EOF
)
ALICE_TOKEN=$(echo "$TOKENS" | sed -n '1p')
BOB_TOKEN=$(echo "$TOKENS" | sed -n '2p')
echo "  Alice and Bob tokens generated"

echo ""
echo "=== Alice registers and indexes a backend ==="
RESPONSE=$(curl -s -X POST "$API/storage-backends/" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"alice-collab-test\", \"backend_type\": \"s3\", \"endpoint_url\": \"http://minio:9000\", \"root_path\": \"$S3_BUCKET\", \"credentials\": {\"provider\": \"env\", \"vars\": {\"access_key\": \"VREFS_MINIO_ACCESS_KEY\", \"secret_key\": \"VREFS_MINIO_SECRET_KEY\"}}}")
BACKEND_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$RESPONSE")
echo "  backend_id=$BACKEND_ID"

curl -s -X POST "$API/storage-backends/$BACKEND_ID/index/" -H "Authorization: Bearer $ALICE_TOKEN" > /dev/null
sleep 1

DATASET_ID=$(curl -s "$API/datasets/?backend=$BACKEND_ID" -H "Authorization: Bearer $ALICE_TOKEN" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['id'])")
echo "  dataset_id=$DATASET_ID"

echo ""
echo "=== Alice sets the dataset public and publishes her lake ==="
curl -s -X PATCH "$API/datasets/$DATASET_ID/" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"status": "public"}' > /dev/null
curl -s -X PATCH "$API/lake/" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"published": true}' > /dev/null
echo "  done"

echo ""
echo "=== Bob discovers Alice's lake ==="
DISCOVER=$(curl -s "$API/discover/" -H "Authorization: Bearer $BOB_TOKEN")
echo "$DISCOVER" | python3 -m json.tool | head -30

echo ""
echo "=== Bob subscribes to Alice ==="
curl -s -X POST "$API/subscriptions/" \
  -H "Authorization: Bearer $BOB_TOKEN" -H "Content-Type: application/json" \
  -d '{"source_owner_id": "test-alice"}'
echo ""

echo ""
echo "=== Bob's subscribed-datasets view ==="
curl -s "$API/subscribed-datasets/" -H "Authorization: Bearer $BOB_TOKEN" | python3 -m json.tool

echo ""
echo "=== Bob imports the dataset ==="
IMPORT_RESULT=$(curl -s -X POST "$API/datasets/$DATASET_ID/import/" -H "Authorization: Bearer $BOB_TOKEN")
echo "$IMPORT_RESULT" | python3 -m json.tool
IMPORTED_ID=$(echo "$IMPORT_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

echo ""
echo "=== Alice's access log (should show Bob's import) ==="
curl -s "$API/datasets/$DATASET_ID/access-log/" -H "Authorization: Bearer $ALICE_TOKEN" | python3 -m json.tool

echo ""
echo "=== Isolation check: delete Alice's original, confirm Bob's import survives ==="
curl -s -X DELETE "$API/datasets/$DATASET_ID/" -H "Authorization: Bearer $ALICE_TOKEN" > /dev/null
echo "  Alice's original deleted."
curl -s "$API/datasets/$IMPORTED_ID/" -H "Authorization: Bearer $BOB_TOKEN" | python3 -m json.tool

echo ""
echo "Done. All five collaboration KPIs exercised above."