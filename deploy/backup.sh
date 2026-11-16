#!/usr/bin/env bash
# Daily SQLite backup for a docker compose deployment (docs/DEPLOY.md).
# Run from the repository directory. Keeps KEEP_DAYS days (default 3): backups hold data that the
# server itself deletes 48 h after an event (docs/PRIVACY.md), so do not keep them longer.
# The master key (KAMEN_MASTER_KEY) is NOT in the backup; store it separately.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-$HOME/kamen-backups}"
KEEP_DAYS="${KEEP_DAYS:-3}"
mkdir -p "$DEST"
chmod 700 "$DEST"
name="kamen-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
docker compose exec -T server node -e \
  "require('better-sqlite3')('/data/kamen.sqlite').backup('/data/backup.sqlite').then(()=>{})"
docker compose cp server:/data/backup.sqlite "$DEST/$name" >/dev/null 2>&1
docker compose exec -T server rm -f /data/backup.sqlite
chmod 600 "$DEST/$name"
find "$DEST" -name 'kamen-*.sqlite' -mtime +"$((KEEP_DAYS - 1))" -delete
echo "$DEST/$name"
