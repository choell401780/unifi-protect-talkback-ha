# unifi-protect-talkback-ha

Vollständige Doorbell-Weboberfläche für UniFi Protect G4/G5 Doorbells.

## Funktionen

- **Live-Kamerabild** — RTSP→HLS via ffmpeg, abgespielt mit HLS.js
- **Gegensprechen (Talkback)** — Browser-Mikrofon → Doorbell-Lautsprecher
- **Lautstärkeregler** — Lautsprecher & Mikrofon der Doorbell
- **Display-Nachrichten** — Text auf dem LCD (G4 Doorbell mit Display)
- **API** — REST-Endpunkte für alle Funktionen
- **Home Assistant Integration** — per iframe oder panel_iframe

## Voraussetzungen

- UniFi Protect NVR (lokaler Netzwerkzugang)
- G4 oder G5 Doorbell
- Lokaler NVR-Account (kein Ubiquiti SSO)
- Node.js 20+
- ffmpeg (im PATH verfügbar)

## Setup

```bash
cp .env.example .env
# .env mit NVR-Zugangsdaten und Camera-ID befüllen
npm install
npm run server        # HTTP auf Port 8080
npm run server:https  # HTTPS (benötigt Zertifikat)
```

Browser öffnen: `http://SERVER-IP:8080`

## Umgebungsvariablen

| Variable | Pflicht | Beschreibung |
|---|---|---|
| `PROTECT_HOST` | ✓ | IP/Hostname des NVR |
| `PROTECT_PORT` | – | HTTPS-Port (Standard: 443) |
| `PROTECT_USERNAME` | ✓ | Lokaler NVR-Account |
| `PROTECT_PASSWORD` | ✓ | NVR-Passwort |
| `PROTECT_CAMERA_ID` | ✓ | Kamera-ID (siehe unten) |
| `SERVER_PORT` | – | HTTP-Port (Standard: 8080) |
| `HTTPS` | – | `1` für HTTPS-Modus |
| `SSL_KEY` / `SSL_CERT` | – | Pfad zu Zertifikat/Key |
| `MEDIA_RECORDER_TIMESLICE_MS` | – | Audio-Chunk-Größe in ms (Standard: 500) |

### Kamera-ID ermitteln

```bash
npm start   # listet alle Kameras mit IDs auf
```

## API-Routen

| Method | Pfad | Beschreibung |
|---|---|---|
| GET | `/api/status` | NVR-Status, Kamerainfo, Stream-Status |
| GET | `/api/camera/stream-info` | RTSP-Kanäle und HLS-URL |
| GET | `/api/settings` | Lautstärke, LCD-Nachricht, Feature-Flags |
| POST | `/api/settings` | Kamera-Einstellungen ändern |
| POST | `/api/display-message` | LCD-Nachricht setzen (body: `{ message }`) |
| GET | `/api/chime-settings` | Klingelton-Einstellungen + verfügbare Töne + PoE Chimes |
| POST | `/api/chime-settings` | Klingelton, Lautstärke, Wiederholung speichern |
| GET | `/hls/stream.m3u8` | HLS-Playlist (live) |
| WS | `/audio` | WebSocket für Talkback-Audio |

## RTSP / HLS

Der Server startet beim Hochfahren automatisch einen ffmpeg-Prozess:

```
RTSP (NVR Port 7447) → ffmpeg → HLS-Segmente (/tmp/protect-hls/)
```

- Latenz: ~3–4 Sekunden (1s-Segmente, 4er-Liste)
- Video: H.264 copy (keine Re-Encodierung)
- Audio: AAC 44100 Hz stereo
- Neustart: automatisch nach 8 Sekunden bei Fehler
- RTSP-Port: 7447 (Standard UniFi Protect, nicht konfigurierbar)

**Falls der Stream nicht startet:**
- Prüfen ob RTSP im NVR aktiviert ist (UniFi Protect → Camera → Advanced → RTSP)
- ffmpeg muss im PATH verfügbar sein: `ffmpeg -version`
- Firewall: NVR-Port 7447 (RTSP) muss erreichbar sein

## HTTPS / Mikrofon

Das Browser-Mikrofon (Talkback) erfordert einen **sicheren Kontext** (HTTPS oder localhost).

Selbst-signiertes Zertifikat erstellen:
```bash
npm run generate:selfsigned-cert
npm run server:https
```

Für Home Assistant als Reverse-Proxy: siehe `docs/HOME_ASSISTANT.md`.

## Klingelton-Funktionen

Die Weboberfläche zeigt einen neuen Bereich **"Klingelton"** mit:

- **Türklingel (intern):** Klingelton-Auswahl, Ring-Lautstärke und Wiederholung des eingebauten Lautsprechers
  - Felder: `speakerSettings.ringVolume`, `ringtoneId`, `repeatTimes`
  - Verfügbar wenn `featureFlags.hasSpeaker = true`
- **PoE Chime:** Einstellungen für verbundene Smart PoE Chime-Geräte
  - Kamera-spezifische Lautstärke, Klingelton und Wiederholung pro Chime
  - Felder: `ringSettings[].volume`, `ringtoneId`, `repeatTimes`
  - Nur angezeigt wenn Chime mit der Kamera verknüpft ist

**Verfügbare Klingeltöne** werden live von `/api/ringtones` geladen:
Default, Traditional, Sundrops, Express-Line (können je nach NVR abweichen).

**Modellabhängigkeit:**
| Funktion | G4 Doorbell Pro | G4 Doorbell | G5 Doorbell |
|---|---|---|---|
| Ring-Lautstärke | ✓ | ✓ | ✓ |
| Klingelton-Auswahl | ✓ | evtl. | ✓ |
| PoE Chime | wenn vorhanden | wenn vorhanden | wenn vorhanden |
| LCD-Display | ✓ | ✗ | ✗ |

## Bekannte Einschränkungen

- Nur ein Talkback gleichzeitig (single session)
- HLS erfordert Internetverbindung für HLS.js CDN (oder lokale Kopie einbinden)
- Kein vollständiges Duplex-Audio (Kamera-Mikrofon → Browser ist nicht implementiert)
- LCD-Display nur bei G4 Doorbell mit Display (featureFlags.hasLcdScreen)
- Lautstärkeregler nur wenn vom Gerät unterstützt (featureFlags.hasSpeaker)
- Kein SIP, kein UniFi Access

## Architektur

Siehe `docs/ARCHITECTURE.md`.

## Home Assistant Add-on

Dieses Repository kann direkt als Home Assistant Add-on-Repository verwendet werden.

### Repository hinzufügen

1. **Einstellungen → Add-ons → Add-on-Store** öffnen.
2. Drei-Punkte-Menü oben rechts → **Repositories**.
3. URL eintragen:
   ```
   https://github.com/YOUR_GITHUB_USER/unifi-protect-talkback-ha
   ```
4. **Hinzufügen** klicken → Add-on **UniFi Protect Doorbell** erscheint im Store.
5. Add-on installieren und im Reiter **Konfiguration** befüllen:

   | Feld | Wert |
   |---|---|
   | `unifi_host` | IP des NVR |
   | `unifi_username` | lokaler NVR-Benutzer |
   | `unifi_password` | NVR-Passwort |
   | `unifi_camera_id` | 24-stellige Hex-ID der Türklingel |

6. Add-on starten. Weboberfläche unter `http://<HA-IP>:8080` erreichbar.

### Kamera-ID ermitteln

Über die NVR-API: `https://<NVR-IP>/proxy/protect/api/cameras`  
Oder in der URL der Kamera in der Protect-Weboberfläche.

### HTTPS / Talkback

Talkback erfordert einen sicheren Kontext im Browser. Optionen:

- **SSL im Add-on aktivieren** (`ssl: true`, HA-Zertifikat wird automatisch eingebunden)
- Oder Zugriff über `https://homeassistant.local` mit Reverse-Proxy

### Vollständige Dokumentation

Die vollständige Add-on-Dokumentation (Konfigurationsfelder, Troubleshooting) findet sich in [`DOCS.md`](DOCS.md).

## Lizenz

MIT
