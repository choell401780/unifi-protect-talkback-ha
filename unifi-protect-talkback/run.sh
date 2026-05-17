#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e

bashio::log.info "Starte UniFi Protect Doorbell Add-on..."

# ── Konfiguration aus /data/options.json ─────────────────────────────────────
PROTECT_HOST="$(bashio::config 'unifi_host')"
PROTECT_PORT="$(bashio::config 'unifi_port')"
PROTECT_USERNAME="$(bashio::config 'unifi_username')"
PROTECT_PASSWORD="$(bashio::config 'unifi_password')"
PROTECT_CAMERA_ID="$(bashio::config 'unifi_camera_id')"
SERVER_PORT="$(bashio::config 'web_port')"
LOG_LEVEL="$(bashio::config 'log_level')"

# ── Pflichtfelder prüfen ──────────────────────────────────────────────────────
if bashio::var.is_empty "${PROTECT_HOST}"; then
    bashio::log.fatal "Konfiguration unvollständig: 'unifi_host' ist nicht gesetzt."
    exit 1
fi
if bashio::var.is_empty "${PROTECT_USERNAME}"; then
    bashio::log.fatal "Konfiguration unvollständig: 'unifi_username' ist nicht gesetzt."
    exit 1
fi
if bashio::var.is_empty "${PROTECT_CAMERA_ID}"; then
    bashio::log.fatal "Konfiguration unvollständig: 'unifi_camera_id' ist nicht gesetzt."
    exit 1
fi

# ── Info-Ausgabe (kein Passwort!) ─────────────────────────────────────────────
bashio::log.info "NVR:          ${PROTECT_HOST}:${PROTECT_PORT}"
bashio::log.info "Benutzer:     ${PROTECT_USERNAME}"
bashio::log.info "Kamera-ID:    ${PROTECT_CAMERA_ID}"
bashio::log.info "Webport:      ${SERVER_PORT}"
bashio::log.info "Log-Level:    ${LOG_LEVEL}"

# ── Umgebungsvariablen exportieren ────────────────────────────────────────────
export PROTECT_HOST
export PROTECT_PORT
export PROTECT_USERNAME
export PROTECT_PASSWORD
export PROTECT_CAMERA_ID
export SERVER_PORT
export LOG_LEVEL
export SERVER=1

# ── SSL-Konfiguration ─────────────────────────────────────────────────────────
if bashio::config.true 'ssl'; then
    CERTFILE="$(bashio::config 'certfile')"
    KEYFILE="$(bashio::config 'keyfile')"
    export HTTPS=1
    export SSL_CERT="/ssl/${CERTFILE}"
    export SSL_KEY="/ssl/${KEYFILE}"
    bashio::log.info "HTTPS aktiviert (${CERTFILE})"
fi

# ── App starten ───────────────────────────────────────────────────────────────
cd /app
exec node_modules/.bin/tsx src/index.ts
