#!/usr/bin/env bash
# Create or update a project and its limits.
# Usage: create-project.sh <name> [maxVus=1000] [maxMinutes=60] [maxConcurrent=2] [maxRunners=15] [maxVuHoursMonth=5000]
set -euo pipefail
source "$(dirname "$0")/_env.sh"
NAME="${1:?usage: create-project.sh <name> [maxVus] [maxMinutes] [maxConcurrent] [maxRunners] [maxVuHoursMonth]}"
[[ "$NAME" =~ ^[a-z0-9-]{2,40}$ ]] || { echo "project name: lowercase letters, digits, dashes"; exit 2; }
ITEM=$(jq -nc --arg n "$NAME" --argjson v "${2:-1000}" --argjson m "${3:-60}" --argjson c "${4:-2}" --argjson r "${5:-15}" --argjson h "${6:-5000}" \
  '{pk:{S:"PROJECT#\($n)"}, name:{S:$n}, maxVus:{N:"\($v)"}, maxMinutes:{N:"\($m)"}, maxConcurrent:{N:"\($c)"}, maxRunners:{N:"\($r)"}, maxVuHoursMonth:{N:"\($h)"}, createdAt:{S:(now|todate)}}')
aws dynamodb put-item --table-name "$TABLE" --item "$ITEM"
echo "Project '$NAME': maxVus=${2:-1000} maxMinutes=${3:-60} maxConcurrent=${4:-2} maxRunners=${5:-15} maxVuHoursMonth=${6:-5000}"
