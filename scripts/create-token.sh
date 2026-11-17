#!/usr/bin/env bash
# Create an API token for a project. The token is shown once; only its SHA-256 hash is stored.
# Usage: scripts/create-token.sh <project> <token-name, e.g. goutham-laptop or shop-app-ci>
set -euo pipefail
source "$(dirname "$0")/_env.sh"
PROJECT="${1:?usage: create-token.sh <project> <name>}"
NAME="${2:?usage: create-token.sh <project> <name>}"
aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"PROJECT#$PROJECT\"}}" --query Item.name.S --output text | grep -qx "$PROJECT" \
  || { echo "project '$PROJECT' not found; create it with scripts/create-project.sh"; exit 1; }
TOKEN="k6kt_$(openssl rand -hex 24)"
HASH=$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)
ITEM=$(jq -nc --arg h "$HASH" --arg p "$PROJECT" --arg n "$NAME" '{pk:{S:"TOKEN#\($h)"}, project:{S:$p}, name:{S:$n}, createdAt:{S:(now|todate)}}')
aws dynamodb put-item --table-name "$TABLE" --item "$ITEM" --condition-expression "attribute_not_exists(pk)"
echo "Token for project '$PROJECT' ($NAME) — copy it now, it is not shown again:"
echo
echo "  $TOKEN"
echo
echo "Log in with:  node cli/k6kt.mjs login --api $(tf_out api_url) --token $TOKEN"
