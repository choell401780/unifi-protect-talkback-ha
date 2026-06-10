#!/usr/bin/env bash
# Führt eine Home Assistant Konfigurationsprüfung per SSH aus.
# Nur lesend — kein schreibender Zugriff auf HA.
set -euo pipefail

HA_HOST="hassio@192.168.188.6"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
LOG_FILE="$LOG_DIR/${TIMESTAMP}_config_check.log"

mkdir -p "$LOG_DIR"

echo "[ha-check-config] Host: $HA_HOST"
echo ""

# SSH-Verbindung testen
if ! ssh $SSH_OPTS "$HA_HOST" "echo ok" &>/dev/null; then
  echo "FEHLER: SSH-Verbindung zu $HA_HOST fehlgeschlagen." >&2
  echo "Bitte SSH-Key autorisieren (siehe README → SSH-Diagnose)." >&2
  exit 1
fi

echo "[ha-check-config] SSH-Verbindung OK"
echo "[ha-check-config] Führe 'ha core check' aus …"
echo ""

ssh $SSH_OPTS -o ConnectTimeout=30 "$HA_HOST" "ha core check" \
  | tee "$LOG_FILE"

echo ""
echo "[ha-check-config] Ergebnis gespeichert: $LOG_FILE"
