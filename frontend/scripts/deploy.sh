#!/usr/bin/env bash
# Build the web app and upload it to S3 behind CloudFront.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-goutham-iam}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
FRONTEND="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$FRONTEND/../terraform"
tf_out() { terraform -chdir="$TF_DIR" output -raw "$1"; }
BUCKET="$(tf_out web_bucket)"
DIST_ID="$(tf_out web_distribution_id)"
API_URL="$(tf_out api_url)"

cd "$FRONTEND"
npm ci --no-audit --no-fund
npm run build
printf '{"apiUrl":"%s"}\n' "$API_URL" > dist/config.json

# Hashed assets can be cached forever; index.html and config.json must always be fresh.
aws s3 sync dist/assets "s3://$BUCKET/assets" --delete --cache-control "public,max-age=31536000,immutable"
aws s3 sync dist "s3://$BUCKET" --delete --exclude "assets/*" --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" "/config.json" "/" >/dev/null
echo "Deployed: $(tf_out web_url)"
