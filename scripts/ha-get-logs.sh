#!/usr/bin/env bash
# Zieht alle relevanten Home Assistant Logs per SSH und speichert sie lokal.
# Nur lesend — kein schreibender Zugriff auf HA.
set -euo pipefail

HA_HOST="root@192.168.188.6"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i ~/.ssh/id_ha_diagnose"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

mkdir -p "$LOG_DIR"

echo "[ha-get-logs] Host:      $HA_HOST"
echo "[ha-get-logs] Log-Dir:   $LOG_DIR"
echo "[ha-get-logs] Zeitstempel: $TIMESTAMP"
echo ""

# SSH-Verbindung testen
if ! ssh $SSH_OPTS "$HA_HOST" "echo ok" &>/dev/null; then
  echo "FEHLER: SSH-Verbindung zu $HA_HOST fehlgeschlagen." >&2
  echo ""
  echo "Bitte SSH-Key autorisieren (siehe README → SSH-Diagnose)." >&2
  echo "Öffentlicher Key dieser Umgebung:" >&2
  cat ~/.ssh/id_ed25519.pub 2>/dev/null || echo "(Kein ~/.ssh/id_ed25519.pub gefunden)" >&2
  exit 1
fi

echo "[ha-get-logs] SSH-Verbindung OK"
echo ""

# Core
echo "[ha-get-logs] Ziehe Core-Logs …"
ssh $SSH_OPTS "$HA_HOST" "ha core logs" \
  > "$LOG_DIR/${TIMESTAMP}_core.log" 2>&1
echo "  → ${TIMESTAMP}_core.log"

# Supervisor
echo "[ha-get-logs] Ziehe Supervisor-Logs …"
ssh $SSH_OPTS "$HA_HOST" "ha supervisor logs" \
  > "$LOG_DIR/${TIMESTAMP}_supervisor.log" 2>&1
echo "  → ${TIMESTAMP}_supervisor.log"

# Host
echo "[ha-get-logs] Ziehe Host-Logs …"
ssh $SSH_OPTS "$HA_HOST" "ha host logs" \
  > "$LOG_DIR/${TIMESTAMP}_host.log" 2>&1
echo "  → ${TIMESTAMP}_host.log"

# Add-on (unifi_protect_doorbell)
echo "[ha-get-logs] Ziehe Add-on-Logs (unifi_protect_doorbell) …"
ssh $SSH_OPTS "$HA_HOST" "ha apps logs e9e5a5d8_unifi_protect_doorbell" \
  > "$LOG_DIR/${TIMESTAMP}_addon.log" 2>&1
echo "  → ${TIMESTAMP}_addon.log"

echo ""
echo "[ha-get-logs] Fertig. Alle Logs gespeichert in: $LOG_DIR"
