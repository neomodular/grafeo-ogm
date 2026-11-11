#!/usr/bin/env bash
# Selects the neo4j-driver a CI leg tests against, after
# `pnpm install --frozen-lockfile`.
#
# The peer range is "^5.0.0 || ^6.0.0" but the lockfile pins one 5.x, so
# without a swap only that version is ever tested.
#
#   lockfile  keep the lockfile's driver (the default legs)
#   x.y.z     install exactly that version; the change to package.json and
#             pnpm-lock.yaml stays in the CI checkout and is never committed
#
# Fails unless the driver Node resolves is the one asked for.
#
# Usage: bash scripts/ci/use-neo4j-driver.sh <lockfile|x.y.z>
set -euo pipefail

want="${1:?usage: use-neo4j-driver.sh <lockfile|x.y.z>}"

if [[ "$want" != lockfile ]]; then
  if [[ ! "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "neo4j-driver: need an exact x.y.z version, got '$want'" >&2
    exit 2
  fi
  pnpm add --save-dev --save-exact "neo4j-driver@$want"
fi

got="$(node -p "require('neo4j-driver/package.json').version")"
echo "neo4j-driver resolved: $got"
if [[ "$want" != lockfile && "$got" != "$want" ]]; then
  echo "neo4j-driver: expected $want, Node resolves $got" >&2
  exit 1
fi
