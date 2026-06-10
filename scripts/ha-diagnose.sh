#!/usr/bin/env bash
# Vollständige Home Assistant Diagnose:
# Zieht alle Logs, prüft Konfiguration und filtert relevante Fehler.
# Nur lesend — kein schreibender Zugriff auf HA.
set -euo pipefail

HA_HOST="root@192.168.188.6"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -i ~/.ssh/id_ha_diagnose"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/../logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
REPORT="$LOG_DIR/${TIMESTAMP}_diagnose.md"

mkdir -p "$LOG_DIR"

echo "╔══════════════════════════════════════════════╗"
echo "║        Home Assistant Diagnose               ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Host:       $HA_HOST"
echo "  Zeitstempel: $TIMESTAMP"
echo "  Report:     $REPORT"
echo ""

# SSH-Verbindung testen
if ! ssh $SSH_OPTS -o ConnectTimeout=10 "$HA_HOST" "echo ok" &>/dev/null; then
  echo "FEHLER: SSH-Verbindung zu $HA_HOST fehlgeschlagen." >&2
  echo ""
  echo "Bitte SSH-Key autorisieren:" >&2
  echo "  1. HA → Einstellungen → Add-ons → SSH & Web Terminal" >&2
  echo "  2. Konfiguration → authorized_keys → Key eintragen:" >&2
  echo "" >&2
  cat ~/.ssh/id_ed25519.pub 2>/dev/null || echo "  (Kein ~/.ssh/id_ed25519.pub gefunden)" >&2
  echo "" >&2
  echo "  3. Add-on neu starten" >&2
  exit 1
fi

echo "  SSH-Verbindung OK"
echo ""

run_cmd() {
  local label="$1"
  local cmd="$2"
  local lines="${3:-100}"
  echo "── $label ──"
  ssh $SSH_OPTS -o ConnectTimeout=30 "$HA_HOST" "$cmd" 2>&1 | tail -"$lines"
  echo ""
}

{
  echo "# Home Assistant Diagnose-Report"
  echo ""
  echo "| Feld | Wert |"
  echo "|------|------|"
  echo "| Datum | $(date) |"
  echo "| Host | $HA_HOST |"
  echo ""

  echo "## Core-Logs (letzte 150 Zeilen)"
  echo '```'
  ssh $SSH_OPTS -o ConnectTimeout=30 "$HA_HOST" "ha core logs" 2>&1 | tail -150
  echo '```'
  echo ""

  echo "## Supervisor-Logs (letzte 80 Zeilen)"
  echo '```'
  ssh $SSH_OPTS -o ConnectTimeout=30 "$HA_HOST" "ha supervisor logs" 2>&1 | tail -80
  echo '```'
  echo ""

  echo "## Add-on-Logs: unifi_protect_doorbell (letzte 250 Zeilen)"
  echo '```'
  ssh $SSH_OPTS -o ConnectTimeout=30 "$HA_HOST" "ha apps logs e9e5a5d8_unifi_protect_doorbell" 2>&1 | tail -250
  echo '```'
  echo ""

  echo "## Host-Logs (letzte 50 Zeilen)"
  echo '```'
  ssh $SSH_OPTS -o ConnectTimeout=30 "$HA_HOST" "ha host logs" 2>&1 | tail -50
  echo '```'
  echo ""

  echo "## Konfigurationsprüfung"
  echo '```'
  ssh $SSH_OPTS -o ConnectTimeout=30 "$HA_HOST" "ha core check" 2>&1
  echo '```'

} | tee "$REPORT"

echo ""
echo "═══════════════════════════════════════════════"
echo "  Relevante Fehler im Add-on-Log:"
echo "═══════════════════════════════════════════════"
echo ""

grep -i "error\|failed\|exception\|warn\|hls\|mse\|rtsp\|ffmpeg\|stream\|socket" "$REPORT" \
  | grep -v "^#\|^\`\`\`\|^|\|^-" \
  | head -60 \
  || echo "  (keine gefunden)"

echo ""
echo "Vollständiger Report: $REPORT"
