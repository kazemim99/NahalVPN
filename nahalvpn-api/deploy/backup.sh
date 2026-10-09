#!/bin/bash
# NahalVPN app backup: users DB (online-safe SQLite .backup), /etc/nahalvpn (secrets, JWT key, OpenVPN PKI, xray config)
# and the OpenVPN CA key, as one tar.gz in $BACKUP_DIR (root only). Keeps the newest $KEEP archives.
# Usage: backup.sh [tag]      (tag goes into the file name, e.g. "manual" or "pre-restore")
set -euo pipefail
umask 077
DB=${API_DB:-/var/lib/nahalvpn-api/nahalvpn.db}
ETC=${API_ETC:-/etc/nahalvpn}
CA_KEY=${CA_KEY:-/root/nahalvpn-openvpn-ca.key}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/nahalvpn}
KEEP=${KEEP:-14}
TAG=${1:-daily}
[[ "$TAG" =~ ^[a-z0-9-]{1,20}$ ]] || { echo "bad tag: $TAG" >&2; exit 2; }

mkdir -p "$BACKUP_DIR"
NAME="nahalvpn-$(date -u +%Y%m%d-%H%M%S)-$TAG"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/$NAME"

sqlite3 "$DB" ".backup '$WORK/$NAME/nahalvpn.db'"
[ "$(sqlite3 "$WORK/$NAME/nahalvpn.db" 'PRAGMA integrity_check')" = "ok" ] || { echo "integrity check failed" >&2; exit 1; }
cp -a "$ETC" "$WORK/$NAME/etc-nahalvpn"
[ -f "$CA_KEY" ] && cp -a "$CA_KEY" "$WORK/$NAME/"
USERS=$(sqlite3 "$WORK/$NAME/nahalvpn.db" 'SELECT COUNT(*) FROM users')
printf 'created=%s\nusers=%s\nhost=%s\n' "$(date -u +%FT%TZ)" "$USERS" "$(hostname)" > "$WORK/$NAME/INFO"

tar czf "$BACKUP_DIR/$NAME.tgz.part" -C "$WORK" "$NAME"
mv "$BACKUP_DIR/$NAME.tgz.part" "$BACKUP_DIR/$NAME.tgz"
chmod 600 "$BACKUP_DIR/$NAME.tgz"

# Retention: newest $KEEP archives stay.
ls -1t "$BACKUP_DIR"/nahalvpn-*.tgz | tail -n +$((KEEP + 1)) | while read -r old; do rm -f -- "$old"; done
echo "backup $BACKUP_DIR/$NAME.tgz users=$USERS size=$(du -h "$BACKUP_DIR/$NAME.tgz" | cut -f1)"
