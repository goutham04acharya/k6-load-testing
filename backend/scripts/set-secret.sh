#!/usr/bin/env bash
# Store a secret for a project's tests (reaches the test as {{KEY}} / __ENV.KEY on AWS runs).
# Usage: set-secret.sh <project> <KEY>      (the value is read from the prompt, not the command line)
set -euo pipefail
source "$(dirname "$0")/_env.sh"
PROJECT="${1:?usage: set-secret.sh <project> <KEY>}"
KEY="${2:?usage: set-secret.sh <project> <KEY>}"
[[ "$KEY" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "KEY must look like an env var name"; exit 2; }
read -r -s -p "Value for $KEY: " VALUE; echo
NAME="$(tf_out secrets_path_prefix)$PROJECT/$KEY"
aws ssm put-parameter --name "$NAME" --type SecureString --value "$VALUE" --overwrite >/dev/null
echo "Saved $NAME"
