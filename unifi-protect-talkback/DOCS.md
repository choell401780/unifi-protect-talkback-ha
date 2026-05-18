# UniFi Protect Doorbell – Dokumentation

## Installation

1. Navigiere in Home Assistant zu **Einstellungen → Add-ons → Add-on-Store**.
2. Klicke oben rechts auf das Drei-Punkte-Menü und wähle **Repositories**.
3. Füge folgende URL hinzu:
   ```
   https://github.com/choell401780/unifi-protect-talkback-ha
   ```
4. Schließe den Dialog. Das Add-on **UniFi Protect Doorbell** erscheint nun im Store.
5. Klicke auf das Add-on und dann auf **Installieren**.

## Konfiguration

Öffne den Reiter **Konfiguration** des Add-ons und passe die Felder an:

| Option | Beschreibung | Pflicht |
|---|---|---|
| `unifi_host` | IP-Adresse oder Hostname der UniFi Console (UDM Pro, CloudKey, UNVR) | ✓ |
| `unifi_port` | HTTPS-Port des NVR (Standard: 443) | |
| `unifi_username` | Benutzername für den Protect-Login | ✓ |
| `unifi_password` | Passwort für den Protect-Login | ✓ |
| `doorbell_name` | Name der Türklingel als Filter (bei mehreren Geräten) | |
| `doorbell_mac` | MAC-Adresse der Türklingel als eindeutiger Filter | |
| `unifi_camera_id` | Direkte Kamera-ID als Fallback (überschreibt Auto-Discovery) | |
| `ssl_verify` | TLS-Zertifikat des NVR prüfen (Standard: false) | |
| `web_port` | Port der Weboberfläche (Standard: 8080) | |
| `ssl` | HTTPS für die Weboberfläche aktivieren | |
| `certfile` | Zertifikatsdatei aus `/ssl/` (z. B. `fullchain.pem`) | |
| `keyfile` | Schlüsseldatei aus `/ssl/` (z. B. `privkey.pem`) | |
| `log_level` | Protokollierungsstufe: `debug`, `info`, `warning`, `error` | |

### Türklingel-Erkennung (Auto-Discovery)

Das Add-on erkennt die Türklingel **automatisch** — eine Kamera-ID ist nicht mehr erforderlich.

**Ablauf:**
1. Nach dem Login werden alle Geräte vom NVR abgerufen.
2. Türklingeln werden anhand von Typ, Modell und Produktname erkannt.
3. **Genau eine Türklingel gefunden:** wird automatisch verwendet.
4. **Mehrere Türklingeln gefunden:** die Weboberfläche zeigt eine Auswahlliste.
5. **Keine Türklingel erkannt:** Fehlermeldung mit Liste aller Geräte zur manuellen Auswahl.

**Optionale Filter** (wenn mehrere Türklingeln vorhanden):
- `doorbell_name`: Filterung nach Name (Teilstring, Groß-/Kleinschreibung egal)
- `doorbell_mac`: Filterung nach MAC-Adresse (eindeutig)
- `unifi_camera_id`: Direkte Angabe der ID überspringt die Erkennung vollständig

### Benötigter UniFi-Protect-Benutzer

Der Benutzer muss in UniFi Protect die Rolle **Administrator** oder mindestens folgende Berechtigungen haben:
- Kameras anzeigen und steuern
- Talkback verwenden
- Kameraeinstellungen ändern (für Lautstärke, Display-Nachrichten, Klingelton)

Ein dedizierter lokaler Benutzer (kein Ubiquiti-Cloud-Konto) wird empfohlen.

## Starten

1. Wechsle zum Reiter **Info** des Add-ons.
2. Klicke auf **Starten**.
3. Überprüfe im Reiter **Protokoll**, ob das Add-on fehlerfrei gestartet ist.

## Weboberfläche öffnen

### Über Home Assistant Sidebar (Ingress — empfohlen)

Nach dem Start erscheint **Türklingel** automatisch in der HA-Seitenleiste.
Kein `panel_iframe`, keine externe URL nötig.

### Direkt (Standalone)

```
http://<Home-Assistant-IP>:<web_port>
```

Standardmäßig: `http://<HA-IP>:8080`

Bei aktiviertem SSL: `https://<HA-IP>:<web_port>`

### Bekannte Einschränkungen bei Ingress

- **Talkback / Mikrofon**: erfordert HTTPS. HA Ingress läuft über HTTPS, daher funktioniert Talkback automatisch über die Sidebar.
- **Livebild (HLS)**: HLS.js wird vom CDN geladen (`cdn.jsdelivr.net`). Falls HA-Instanz keinen Internetzugang hat, schlägt das Laden fehl.
- **WebSocket**: wird durch HA Ingress korrekt proxiert.

## Funktionsumfang

- **Auto-Discovery**: Türklingel wird automatisch erkannt, keine manuelle ID nötig
- **Livebild**: RTSP-Stream der Türklingel (HLS, ~3 s Verzögerung)
- **Talkback**: Sprechen über den Lautsprecher der Türklingel (WebSocket)
- **Display-Nachrichten**: Text auf dem LCD-Display der Türklingel anzeigen
- **Klingelton-Steuerung**: Klingelton und Lautstärke der Türklingel sowie eines angeschlossenen PoE-Chimes einstellen
- **Lautstärke**: Lautsprecher- und Mikrofonlautstärke der Kamera anpassen

## Troubleshooting

**Add-on startet nicht**
- Prüfe im Protokoll die Fehlermeldung.
- Stelle sicher, dass `unifi_host`, `unifi_username` und `unifi_password` gesetzt sind.

**Keine Türklingel erkannt**
- Die Weboberfläche zeigt alle gefundenen Geräte mit Name, Modell und MAC.
- Ein Gerät kann manuell ausgewählt werden.
- Als Fallback kann `unifi_camera_id` direkt gesetzt werden.
- Debug-API: `GET /api/devices` zeigt alle erkannten Geräte.

**Livebild lädt nicht**
- Der NVR muss über Netzwerk erreichbar sein.
- RTSP-Port 7447 muss zwischen HA und NVR offen sein.
- ffmpeg startet intern – bei Problemen `log_level: debug` setzen.

**Talkback funktioniert nicht**
- Browser muss Mikrofonzugriff erlauben.
- HTTPS ist für `getUserMedia` auf manchen Browsern erforderlich – `ssl: true` aktivieren.

**Klingelton-Vorschau stumm**
- Browser blockiert möglicherweise Autoplay. Einmal auf der Seite klicken, dann erneut versuchen.

**Verbindung zum NVR schlägt fehl**
- Das Add-on akzeptiert selbstsignierte Zertifikate des NVR automatisch (`ssl_verify: false`).
- Prüfe Benutzername und Passwort in der Konfiguration.

## Sicherheits-Hinweise

- Der **standardmäßige Zugriff erfolgt über Home Assistant Ingress** und ist damit durch die HA-Authentifizierung geschützt. Der direkte Port `8080` ist im Auslieferungszustand **nicht** im LAN exponiert.
- Wer direkten LAN-Zugriff benötigt, kann in der Add-on-Konfiguration unter **Netzwerk** den Host-Port setzen. Achtung: in diesem Modus läuft das Add-on **ohne Authentifizierung** und sollte nur in einem vertrauenswürdigen Netzwerk betrieben werden.
- Für die NVR-Verbindung wird ein **lokaler Benutzer** (kein Ubiquiti-Cloud-Konto) empfohlen.

## Trademark / Disclaimer

This add-on is an independent, community-built project. It is **not affiliated with, endorsed by, sponsored by, or officially supported by Ubiquiti Inc.** "UniFi" and "UniFi Protect" are trademarks of Ubiquiti Inc.
