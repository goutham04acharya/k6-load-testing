#!/usr/bin/env bash
# Revoke a token (it stops working immediately). Usage: revoke-token.sh <token>
set -euo pipefail
source "$(dirname "$0")/_env.sh"
TOKEN="${1:?usage: revoke-token.sh <token>}"
HASH=$(printf '%s' "$TOKEN" | sha256sum | cut -d' ' -f1)
aws dynamodb update-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"TOKEN#$HASH\"}}" \
  --update-expression "SET revoked = :t" --expression-attribute-values '{":t":{"BOOL":true}}' \
  --condition-expression "attribute_exists(pk)" >/dev/null
echo "Token revoked."
