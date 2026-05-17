# Milestones

## M0 – Project Setup ✅
- Repository structure
- Documentation: ARCHITECTURE, ENVIRONMENT, MILESTONES, README
- No implementation

## M1 – UniFi Protect Authentication
- Login via `POST /api/auth/login` (local account)
- Store cookie + CSRF token
- Verify connection to NVR
- List cameras (smoke test)

## M2 – Talkback Session Management
- Open Talkback session via REST API (`PUT .../talkback`)
- Connect to Talkback WebSocket
- Send dummy audio (silence) to verify session stays open
- Close session cleanly

## M3 – Audio Ingestion Gateway
- Local HTTP endpoint to receive raw audio from Home Assistant
- Buffer incoming audio chunks
- Feed chunks into open Talkback WebSocket

## M4 – Home Assistant Integration
- `rest_command` or `shell_command` trigger from HA automation
- Doorbell press → HA sends audio → gateway → doorbell speaker
- End-to-end test with real doorbell

## M5 – Hardening (Post-PoC)
- Reconnect logic for WebSocket drops
- Timeout handling for Talkback sessions
- Structured logging
- Basic input validation
