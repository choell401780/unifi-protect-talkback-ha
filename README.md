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

- UniFi Protect Console (UDM Pro, CloudKey, UNVR) — lokaler Netzwerkzugang
- G4 oder G5 Doorbell (wird automatisch erkannt)
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
| `PROTECT_HOST` | ✓ | IP/Hostname der UniFi Console |
| `PROTECT_PORT` | – | HTTPS-Port (Standard: 443) |
| `PROTECT_USERNAME` | ✓ | Lokaler NVR-Account |
| `PROTECT_PASSWORD` | ✓ | NVR-Passwort |
| `DOORBELL_NAME` | – | Namensfilter für Auto-Discovery |
| `DOORBELL_MAC` | – | MAC-Adressfilter für Auto-Discovery |
| `PROTECT_CAMERA_ID` | – | Direkte Kamera-ID (überschreibt Discovery) |
| `SSL_VERIFY` | – | `1` = TLS-Zertifikat des NVR prüfen |
| `SERVER_PORT` | – | HTTP-Port (Standard: 8080) |
| `HTTPS` | – | `1` für HTTPS-Modus |
| `SSL_KEY` / `SSL_CERT` | – | Pfad zu Zertifikat/Key |
| `MEDIA_RECORDER_TIMESLICE_MS` | – | Audio-Chunk-Größe in ms (Standard: 500) |

### Türklingel-Erkennung

```bash
npm start   # zeigt alle Geräte mit isDoorbell-Flag
```

Bei mehreren Türklingeln kann `DOORBELL_NAME` oder `DOORBELL_MAC` gesetzt werden.

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
Das Add-on unterstützt **Ingress** — die Oberfläche erscheint direkt in der HA-Seitenleiste, kein `panel_iframe` nötig.

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

## SSH-Diagnose (Home Assistant)

Das Projekt enthält Diagnose-Skripte, die sich per SSH lesend auf Home Assistant verbinden und Logs lokal speichern.

### SSH-Key autorisieren

**Einmalige Einrichtung in Home Assistant:**

1. **HA → Einstellungen → Add-ons → SSH & Web Terminal → Konfiguration**
2. Unter `authorized_keys` den folgenden Key eintragen:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJRbu6TCleeQ0ShbluWyy7vm27FFKuW4ayJIAmWduaLn claude-homeassistant
```

3. Add-on **Speichern** und **Neu starten**

> Alternativ in der WSL-Umgebung per `cat ~/.ssh/id_ed25519.pub` anzeigen.

### Verbindung testen

```bash
ssh hassio@192.168.188.6
```

### Diagnose-Skripte

```bash
# Alle Logs ziehen (Core, Supervisor, Host, Add-on)
bash scripts/ha-get-logs.sh

# Konfigurationsprüfung
bash scripts/ha-check-config.sh

# Vollständige Diagnose inkl. Fehler-Filter
bash scripts/ha-diagnose.sh
```

Logs werden mit Zeitstempel in `logs/` gespeichert (`logs/*.log`, niemals commitet).

### Erlaubte Diagnose-Befehle (nur lesend)

| Befehl | Beschreibung |
|--------|-------------|
| `ha core logs` | Home Assistant Core Logs |
| `ha supervisor logs` | Supervisor Logs |
| `ha host logs` | Host-System Logs |
| `ha addons logs <slug>` | Add-on Logs |
| `ha core check` | Konfigurationsprüfung |

> Schreibende Befehle (`restart`, `stop`, `uninstall`, Konfigurationsänderungen) sind **nicht** in den Skripten enthalten und werden nur auf ausdrückliche Anforderung ausgeführt.

## Sicherheits-Hinweise

- **Standardmäßig wird nur Home Assistant Ingress verwendet** — der Zugriff geht durch HA-Authentifizierung. Eine Veröffentlichung des direkten Port `8080` über das Netzwerk (in der Add-on-„Netzwerk"-Lasche) **deaktiviert diese Authentifizierung**. Nur aktivieren, wenn der Server in einem vertrauenswürdigen LAN steht.
- **Lokaler NVR-Account verwenden** (kein Ubiquiti-Cloud-/SSO-Konto). Empfohlen: dedizierter Benutzer mit minimalen Rechten (Kamera ansehen, Talkback, Kamera-Einstellungen).
- **Selbst-signierte Zertifikate** werden gegenüber dem NVR per Default akzeptiert (`SSL_VERIFY=0`). Wenn der NVR ein vertrauenswürdiges Zertifikat besitzt, `SSL_VERIFY=1` setzen.
- **HLS.js wird per CDN geladen** (`cdn.jsdelivr.net`). Installationen ohne Internetzugang können die Datei lokal in `web/` bundeln.
- **CORS / Frame-Ancestors** sind standardmäßig auf same-origin + Ingress / panel_iframe begrenzt. Über die ENV-Variablen `CORS_ALLOW_ORIGIN` und `FRAME_ANCESTORS` können andere Origins erlaubt werden.

Bei einer öffentlichen Veröffentlichung dieses Repos vorher prüfen, dass keine echten Credentials in `.env`, kein privater Schlüssel in `certs/` und kein Build-Artefakt in `dist/` mehr enthalten ist (siehe `.gitignore`).

## Trademark / Disclaimer

This project is an **independent**, community-built tool. It is **not affiliated with, endorsed by, sponsored by, or officially supported by Ubiquiti Inc.** "UniFi", "UniFi Protect" and related product names are trademarks of Ubiquiti Inc. All other trademarks are the property of their respective owners.

This software is provided "AS IS" without warranty of any kind — see [`LICENSE`](LICENSE).

## Lizenz

Released under the [MIT License](LICENSE).
