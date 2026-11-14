#!/usr/bin/env bash
# Copy the live web app (Cloudflare Worker public/) into web/ so
# `npx cap sync ios` bundles a current snapshot. The iOS app loads the
# live site via server.url, so this is a fallback, not the source of truth.
# Usage: ./sync-web.sh
set -euo pipefail
SRC="$HOME/workspace/wheelgrade-cloudflare/public"
DST="$(cd "$(dirname "$0")" && pwd)/web"
rm -rf "$DST"
mkdir -p "$DST"
cp -r "$SRC"/. "$DST"/
echo "web/ synced from $SRC ($(ls "$DST" | wc -l) files)"
