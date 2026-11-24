#!/usr/bin/env bash
# Install the same k6 binary the machines use into ~/.local/bin (Linux x86_64), copied from the official image.
set -euo pipefail
VERSION="${K6_VERSION:-2.4.0}"
mkdir -p "$HOME/.local/bin"
ID=$(docker create "grafana/k6:$VERSION")
docker cp "$ID:/usr/bin/k6" "$HOME/.local/bin/k6"
docker rm "$ID" >/dev/null
"$HOME/.local/bin/k6" version
