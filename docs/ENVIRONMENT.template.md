# Environment Variables

Copy `.env.example` to `.env` and fill in your values.

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `PROTECT_HOST` | yes | `192.168.1.1` | IP or hostname of UniFi Protect NVR |
| `PROTECT_PORT` | no | `443` | HTTPS port (default: 443) |
| `PROTECT_USERNAME` | yes | `localuser` | Local NVR account (not Ubiquiti SSO) |
| `PROTECT_PASSWORD` | yes | `secret` | NVR account password |
| `PROTECT_CAMERA_ID` | yes | `abc123def456` | Camera ID from Protect API |
| `GATEWAY_PORT` | no | `8080` | Local HTTP port for audio ingestion (default: 8080) |
| `LOG_LEVEL` | no | `debug` | Log verbosity: `debug`, `info`, `warn`, `error` |

## Notes

- Use a **local NVR account**, not a Ubiquiti cloud account (SSO blocks API access)
- `PROTECT_CAMERA_ID` can be found via `GET /proxy/protect/api/cameras`
- Self-signed NVR certificates are accepted by default (PoC only)
