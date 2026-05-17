# Architecture

## Overview

Local gateway that receives audio from Home Assistant and streams it to a UniFi Protect G4/G5 Doorbell via the Talkback channel.

```
Home Assistant
    │  (HTTP POST or WebSocket, raw PCM/Opus audio)
    ▼
unifi-protect-talkback-ha (Node.js, local)
    │  (WebSocket, Talkback protocol)
    ▼
UniFi Protect NVR
    │  (internal)
    ▼
G4/G5 Doorbell Speaker
```

## Constraints

- No SIP, no UniFi Access
- UniFi Protect only (WebSocket API)
- Push-to-Talk only (half-duplex)
- No Docker, no UI
- Proof of Concept

## Components

| Component | Role |
|-----------|------|
| `src/protect-client.ts` | Authenticates with NVR, manages WebSocket connection |
| `src/talkback.ts` | Handles Talkback channel open/close and audio streaming |
| `src/gateway.ts` | Receives audio from Home Assistant (HTTP or WebSocket) |
| `src/index.ts` | Entry point, wires components together |

## Talkback Protocol (UniFi Protect)

1. Authenticate via `POST /api/auth/login` → receive cookie + CSRF token
2. Open WebSocket `wss://<nvr>/proxy/protect/ws/updates`
3. To start talkback: send `PUT /proxy/protect/api/cameras/<id>/talkback` with `{ enabled: true }`
4. Stream audio via dedicated WebSocket `wss://<nvr>/proxy/protect/ws/talkback/<session-id>`
5. Audio format: PCM 16-bit, 16 kHz, mono (or Opus depending on firmware)
6. Stop: `PUT` with `{ enabled: false }`

## Audio Flow

Home Assistant sends raw audio → gateway buffers → streams chunks over Talkback WebSocket.
No transcoding in PoC; audio format must match what the doorbell expects.
