#!/usr/bin/env bash
# Create an API token for a project. The token is shown once; only its SHA-256 hash is stored.
# Usage: create-token.sh <project> <token-name, e.g. alice-laptop or shop-app-ci>
set -euo pipefail
source "$(dirname "$0")/_env.sh"
PROJECT="${1:?usage: create-token.sh <project> <name>}"
NAME="${2:?usage: create-token.sh <project> <name>}"
aws dynamodb get-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"PROJECT#$PROJECT\"}}" --query Item.name.S --output text | grep -qx "$PROJECT" \
  || { echo "project '$PROJECT' not found; create it with create-project.sh"; exit 1; }
TOKEN="ltk6_$(openssl rand -hex 24)"
HASH=$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)
ITEM=$(jq -nc --arg h "$HASH" --arg p "$PROJECT" --arg n "$NAME" '{pk:{S:"TOKEN#\($h)"}, project:{S:$p}, name:{S:$n}, createdAt:{S:(now|todate)}}')
aws dynamodb put-item --table-name "$TABLE" --item "$ITEM" --condition-expression "attribute_not_exists(pk)"
echo "Token for project '$PROJECT' ($NAME). Copy it now, it is not shown again:"
echo
echo "  $TOKEN"
echo
echo "Web app: $(tf_out web_url)   (sign in with the token)"
echo "CLI:     loadtest login --api $(tf_out api_url) --token $TOKEN"
