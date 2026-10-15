#!/bin/sh
# Drop privileges from root to the yasha user (allows chown of bind-mounted /data
# on first boot, then runs the app as non-root). If already non-root, exec directly.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$(dirname "${DATABASE_PATH:-/data/yasha.db}")"
  chown -R yasha:yasha "$(dirname "${DATABASE_PATH:-/data/yasha.db}")" 2>/dev/null || true
  exec gosu yasha "$@"
fi
exec "$@"
