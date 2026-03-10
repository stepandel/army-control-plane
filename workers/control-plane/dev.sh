#!/usr/bin/env bash
# Load .dev.vars safely (handles values with special characters) and start wrangler dev
set -e

if [ -f .dev.vars ]; then
  while IFS='=' read -r key value; do
    # Skip comments and blank lines
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    # Trim whitespace from key
    key=$(echo "$key" | xargs)
    # Strip surrounding quotes from value
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    export "$key=$value"
  done < .dev.vars
fi

exec wrangler dev "$@"
