# unifi-protect-talkback-ha

Local Push-to-Talk gateway for UniFi Protect G4/G5 Doorbells, triggered by Home Assistant.

**Proof of Concept — not production-ready.**

## What it does

Receives audio from a Home Assistant automation and streams it to a UniFi Protect doorbell speaker via the Talkback WebSocket API.

## What it does NOT do

- No SIP
- No UniFi Access
- No full-duplex / two-way audio
- No Docker

## Requirements

- UniFi Protect NVR (local network access)
- G4 or G5 Doorbell
- Local NVR account (not Ubiquiti SSO)
- Node.js 20+

## Setup

```bash
cp .env.example .env
# edit .env with your NVR credentials and camera ID
npm install
npm run server   # starts Push-to-Talk server on port 8080
```

See [docs/ENVIRONMENT.template.md](docs/ENVIRONMENT.template.md) for all variables.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Home Assistant Integration

See [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md).

## Milestones

See [docs/MILESTONES.md](docs/MILESTONES.md).

## License

MIT
