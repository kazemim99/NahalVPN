#!/bin/bash
# Restores a NahalVPN backup made by backup.sh. Everything changed after that backup (new accounts, renewals,
# password changes) is lost, so the current state is backed up first ("pre-restore") and can be restored back.
# Usage: restore.sh <backup.tgz> [--with-config]
#   default        restores the users DB only (normal case: same server, data went wrong)
#   --with-config  also restores /etc/nahalvpn and the OpenVPN CA key (moving to a new server)
set -euo pipefail
umask 077
ARCHIVE=${1:?usage: restore.sh <backup.tgz> [--with-config]}
WITH_CONFIG=${2:-}
DB=${API_DB:-/var/lib/nahalvpn-api/nahalvpn.db}
ETC=${API_ETC:-/etc/nahalvpn}
CA_KEY=${CA_KEY:-/root/nahalvpn-openvpn-ca.key}
SERVICE=${SERVICE:-nahalvpn-api}          # "none" skips stop/start (tests)
OWNER=${DB_OWNER:-nahalvpn:nahalvpn}
HERE=$(cd "$(dirname "$0")" && pwd)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
tar xzf "$ARCHIVE" -C "$WORK"
SRC=$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'nahalvpn-*' | head -1)
[ -n "$SRC" ] && [ -f "$SRC/nahalvpn.db" ] || { echo "not a NahalVPN backup: $ARCHIVE" >&2; exit 1; }
[ "$(sqlite3 "$SRC/nahalvpn.db" 'PRAGMA integrity_check')" = "ok" ] || { echo "backup DB is damaged" >&2; exit 1; }
echo "restoring: $(tr '\n' ' ' < "$SRC/INFO")"

echo "safety copy of the current state:"
"$HERE/backup.sh" pre-restore

[ "$SERVICE" = none ] || systemctl stop "$SERVICE"
rm -f -- "$DB-wal" "$DB-shm"
cp "$SRC/nahalvpn.db" "$DB"
chown "$OWNER" "$DB"; chmod 644 "$DB"
if [ "$WITH_CONFIG" = "--with-config" ]; then
  cp -a "$SRC/etc-nahalvpn/." "$ETC/"
  [ -f "$SRC/$(basename "$CA_KEY")" ] && cp -a "$SRC/$(basename "$CA_KEY")" "$CA_KEY"
  echo "config restored into $ETC"
fi
if [ "$SERVICE" != none ]; then
  systemctl start "$SERVICE"; sleep 4
  echo "$SERVICE=$(systemctl is-active "$SERVICE") health=$(curl -s -m5 http://127.0.0.1:8790/healthz)"
fi
echo "restored users: $(sqlite3 -readonly "$DB" 'SELECT COUNT(*) FROM users')"
