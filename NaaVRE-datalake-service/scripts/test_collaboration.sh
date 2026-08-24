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

echo "=== Ensuring dependencies are installed ==="
python3 -c "import jwt" 2>/dev/null || pip install pyjwt --quiet
python3 -c "import boto3" 2>/dev/null || pip install boto3 --quiet

echo "=== Ensuring S3 test bucket and test files exist ==="
python3 - <<PYEOF
import boto3

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
    s3.put_object(Bucket=bucket, Key="sample2.txt", Body=b"Test file for vreFS collaboration testing.\n")
    print("  Uploaded 2 test files")
else:
    print(f"  Bucket already has {len(objects)} object(s), leaving as is")
PYEOF
echo ""

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
RESPONSE=$(curl -s --max-time 15 -X POST "$API/storage-backends/" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"alice-collab-test\", \"backend_type\": \"s3\", \"endpoint_url\": \"http://minio:9000\", \"root_path\": \"$S3_BUCKET\", \"credentials\": {\"provider\": \"env\", \"vars\": {\"access_key\": \"VREFS_MINIO_ACCESS_KEY\", \"secret_key\": \"VREFS_MINIO_SECRET_KEY\"}}}")
BACKEND_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['id'])" "$RESPONSE")
echo "  backend_id=$BACKEND_ID"

curl -s --max-time 15 -X POST "$API/storage-backends/$BACKEND_ID/index/" -H "Authorization: Bearer $ALICE_TOKEN" > /dev/null
sleep 1

DATASET_ID=$(curl -s --max-time 15 "$API/datasets/?backend=$BACKEND_ID" -H "Authorization: Bearer $ALICE_TOKEN" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['id'])")
echo "  dataset_id=$DATASET_ID"

echo ""
echo "=== Alice sets the dataset public and publishes her lake ==="
curl -s --max-time 15 -X PATCH "$API/datasets/$DATASET_ID/" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"status": "public"}' > /dev/null
curl -s --max-time 15 -X PATCH "$API/lake/" \
  -H "Authorization: Bearer $ALICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"published": true}' > /dev/null
echo "  done"

echo ""
echo "=== Bob discovers Alice's lake ==="
DISCOVER=$(curl -s --max-time 15 "$API/discover/" -H "Authorization: Bearer $BOB_TOKEN")
echo "$DISCOVER" | python3 -m json.tool | head -30

echo ""
echo "=== Bob subscribes to Alice ==="
curl -s --max-time 15 -X POST "$API/subscriptions/" \
  -H "Authorization: Bearer $BOB_TOKEN" -H "Content-Type: application/json" \
  -d '{"source_owner_id": "test-alice"}'
echo ""

echo ""
echo "=== Bob's subscribed-datasets view ==="
curl -s --max-time 15 "$API/subscribed-datasets/" -H "Authorization: Bearer $BOB_TOKEN" | python3 -m json.tool

echo ""
echo "=== Bob imports the dataset ==="
IMPORT_RESULT=$(curl -s --max-time 15 -X POST "$API/datasets/$DATASET_ID/import/" -H "Authorization: Bearer $BOB_TOKEN")
echo "$IMPORT_RESULT" | python3 -m json.tool
IMPORTED_ID=$(echo "$IMPORT_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

echo ""
echo "=== Alice's access log (should show Bob's import) ==="
curl -s --max-time 15 "$API/datasets/$DATASET_ID/access-log/" -H "Authorization: Bearer $ALICE_TOKEN" | python3 -m json.tool

echo ""
echo "=== Isolation check: delete Alice's original, confirm Bob's import survives ==="
curl -s --max-time 15 -X DELETE "$API/datasets/$DATASET_ID/" -H "Authorization: Bearer $ALICE_TOKEN" > /dev/null
echo "  Alice's original deleted."
curl -s --max-time 15 "$API/datasets/$IMPORTED_ID/" -H "Authorization: Bearer $BOB_TOKEN" | python3 -m json.tool

echo ""
echo "Done. All five collaboration KPIs exercised above."