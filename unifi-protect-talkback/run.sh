#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -e

bashio::log.info "Starte UniFi Protect Doorbell Add-on..."

# ── Pflichtfelder ─────────────────────────────────────────────────────────────
PROTECT_HOST="$(bashio::config 'unifi_host')"
PROTECT_PORT="$(bashio::config 'unifi_port')"
PROTECT_USERNAME="$(bashio::config 'unifi_username')"
PROTECT_PASSWORD="$(bashio::config 'unifi_password')"
SERVER_PORT="$(bashio::config 'web_port')"
LOG_LEVEL="$(bashio::config 'log_level')"

if bashio::var.is_empty "${PROTECT_HOST}"; then
    bashio::log.fatal "Konfiguration unvollständig: 'unifi_host' ist nicht gesetzt."
    exit 1
fi
if bashio::var.is_empty "${PROTECT_USERNAME}"; then
    bashio::log.fatal "Konfiguration unvollständig: 'unifi_username' ist nicht gesetzt."
    exit 1
fi

# ── Optionale Discovery-Felder ────────────────────────────────────────────────
PROTECT_CAMERA_ID="$(bashio::config 'unifi_camera_id' '')"
DOORBELL_NAME="$(bashio::config 'doorbell_name' '')"
DOORBELL_MAC="$(bashio::config 'doorbell_mac' '')"

# ── SSL-Verifizierung gegen NVR ───────────────────────────────────────────────
SSL_VERIFY=0
if bashio::config.true 'ssl_verify'; then
    SSL_VERIFY=1
fi

# ── Info-Ausgabe (kein Passwort!) ─────────────────────────────────────────────
bashio::log.info "NVR:            ${PROTECT_HOST}:${PROTECT_PORT}"
bashio::log.info "Benutzer:       ${PROTECT_USERNAME}"
bashio::log.info "Webport:        ${SERVER_PORT}"
bashio::log.info "Log-Level:      ${LOG_LEVEL}"
bashio::log.info "SSL-Verify NVR: ${SSL_VERIFY}"

if ! bashio::var.is_empty "${PROTECT_CAMERA_ID}"; then
    bashio::log.info "Kamera-ID (manuell): ${PROTECT_CAMERA_ID}"
fi
if ! bashio::var.is_empty "${DOORBELL_NAME}"; then
    bashio::log.info "Doorbell-Filter (Name): ${DOORBELL_NAME}"
fi
if ! bashio::var.is_empty "${DOORBELL_MAC}"; then
    bashio::log.info "Doorbell-Filter (MAC): ${DOORBELL_MAC}"
fi

# ── Umgebungsvariablen exportieren ────────────────────────────────────────────
export PROTECT_HOST
export PROTECT_PORT
export PROTECT_USERNAME
export PROTECT_PASSWORD
export PROTECT_CAMERA_ID
export DOORBELL_NAME
export DOORBELL_MAC
export SSL_VERIFY
export SERVER_PORT
export LOG_LEVEL
export SERVER=1

# ── SSL für Weboberfläche ─────────────────────────────────────────────────────
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
