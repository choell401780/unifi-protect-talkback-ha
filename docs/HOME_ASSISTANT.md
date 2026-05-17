# Home Assistant Integration

Der lokale Push-to-Talk-Server (`npm run server`) läuft auf Port 8080 und liefert eine fertige Web-UI. Diese lässt sich direkt in Home Assistant einbinden — ohne Add-on, ohne HACS.

---

## Voraussetzung: HTTPS und Mikrofon

Browser erlauben Mikrofon-Zugriff (`getUserMedia`) **nur** auf:
- `https://` (egal woher), oder
- `http://localhost` (nur lokal im Browser selbst)

**Problem:** Wenn HA über HTTPS läuft (typisch bei Nabu Casa oder eigenem Reverse-Proxy), wird der iframe unter HTTPS geladen. Der darin enthaltene `http://SERVER-IP:8080`-Frame ist dann **mixed content** → Browser blockiert Mikrofon.

**Lösungen:**
| Situation | Lösung |
|-----------|--------|
| HA hinter Reverse-Proxy | Server ebenfalls hinter demselben Proxy, z.B. `https://ha.home/talkback/` → Proxy zu `http://localhost:8080` |
| HA nur HTTP (lokal) | Direkt `http://SERVER-IP:8080` funktioniert |
| Self-signed Zertifikat | Server mit `npm run server:https` starten (siehe unten) |
| Fully Kiosk Tablet | Mikrofon-Permission in FKB dauerhaft erlauben (siehe unten) |

### Server mit Self-Signed-Zertifikat (HTTPS)

```bash
# Einmalig: Zertifikat erzeugen
npm run generate:selfsigned-cert

# Server mit HTTPS starten
npm run server:https
```

Erreichbar unter `https://SERVER-IP:8080`.

> **Wichtig:** Das self-signed Zertifikat muss am Tablet/Browser **einmalig manuell akzeptiert** werden:
> 1. `https://SERVER-IP:8080` direkt im Browser öffnen
> 2. Sicherheitswarnung bestätigen („Trotzdem fortfahren")
> 3. Danach funktioniert der iframe in HA ohne Warnung

---

## Variante A: Lovelace iframe card

In einer Dashboard-YAML-Karte:

```yaml
type: iframe
url: http://SERVER-IP:8080
aspect_ratio: 60%
```

Oder über die UI: **Dashboard → Karte hinzufügen → Webpage** → URL eintragen.

> Funktioniert nur, wenn HA selbst über HTTP erreichbar ist **oder** der Server über HTTPS mit gültigem Zertifikat läuft.

---

## Variante B: Sidebar Panel (persistent)

In `configuration.yaml`:

```yaml
panel_iframe:
  doorbell_ptt:
    title: "Doorbell Talk"
    icon: mdi:doorbell-video
    url: "http://SERVER-IP:8080"
```

Nach HA-Neustart erscheint das Panel in der Sidebar. Klick → Push-to-Talk direkt in HA.

---

## Variante C: Fully Kiosk Browser (Tablet)

Fully Kiosk Browser (FKB) ist der Standard für HA-Wandtablets und unterstützt Mikrofon-Permissions.

**Einstellungen in FKB:**

1. **Web Content Settings → Camera & Microphone Access**
   - `Allow Camera/Microphone Access`: ✅ aktivieren
   - Optional: `Trusted URL` auf `http://SERVER-IP:8080` setzen

2. **Advanced Web Settings**
   - `Autoplay Videos`: ✅ (falls Audio-Feedback gewünscht)
   - `JavaScript Enabled`: ✅

3. **Kiosk Mode**
   - Der Button ist auch per Touch auf Tablets nutzbar (touchstart/touchend ist implementiert)

**Empfehlung:** FKB-Dashboard als Startseite auf `http://HA-IP:8123`, Doorbell-Panel im Sidebar. Beim Klingeln → Panel öffnen → halten → sprechen.

---

## Autostart des Servers

Damit `npm run server` beim Systemstart läuft, z.B. als systemd-Service:

```ini
# /etc/systemd/system/unifi-talkback.service
[Unit]
Description=UniFi Protect Talkback Gateway
After=network.target

[Service]
WorkingDirectory=/path/to/unifi-protect-talkback-ha
ExecStart=/usr/bin/node --import tsx/esm src/index.ts
Environment=SERVER=1
EnvironmentFile=/path/to/unifi-protect-talkback-ha/.env
Restart=on-failure
User=YOUR_USER

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now unifi-talkback
```

---

## Reverse-Proxy (nginx, HTTPS)

Minimal-Config, um den Server unter `https://ha.local/talkback` erreichbar zu machen:

```nginx
location /talkback/ {
    proxy_pass         http://localhost:8080/;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host $host;
}
```

> WebSocket (`/audio`) muss mitgeprowt werden — `Upgrade`-Header ist entscheidend.
