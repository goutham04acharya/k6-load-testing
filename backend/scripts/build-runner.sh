#!/usr/bin/env bash
# Build the runner image and push it to ECR as :latest (machines always pull :latest).
set -euo pipefail
source "$(dirname "$0")/_env.sh"
REPO="$(tf_out ecr_repository_url)"
REGISTRY="${REPO%%/*}"
TAG="$(date +%Y%m%d-%H%M%S)"
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
docker build --platform linux/amd64 -t "$REPO:latest" -t "$REPO:$TAG" "$REPO_ROOT/backend/runner"
docker push "$REPO:$TAG"
docker push "$REPO:latest"
echo "Pushed $REPO:latest ($TAG)"
