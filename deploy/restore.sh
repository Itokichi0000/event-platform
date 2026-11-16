#!/usr/bin/env bash
# Restore a backup made by deploy/backup.sh (docs/DEPLOY.md). Run from the repository directory:
#   deploy/restore.sh ~/kamen-backups/kamen-YYYYMMDDTHHMMSSZ.sqlite
# The server must use the same KAMEN_MASTER_KEY as when the backup was taken.
set -euo pipefail
cd "$(dirname "$0")/.."
src="${1:?usage: deploy/restore.sh BACKUP_FILE}"
[ -f "$src" ] || { echo "not found: $src" >&2; exit 1; }
docker compose stop server
docker compose cp "$src" server:/data/kamen.sqlite.restore >/dev/null 2>&1
docker compose run --rm --no-deps -T -u root --entrypoint sh server -c \
  'mv /data/kamen.sqlite.restore /data/kamen.sqlite && rm -f /data/kamen.sqlite-wal /data/kamen.sqlite-shm && chown node:node /data/kamen.sqlite && chmod 600 /data/kamen.sqlite'
docker compose start server
echo "restored $src"
