# UniFi Protect Doorbell – Dokumentation

## Installation

1. Navigiere in Home Assistant zu **Einstellungen → Add-ons → Add-on-Store**.
2. Klicke oben rechts auf das Drei-Punkte-Menü und wähle **Repositories**.
3. Füge folgende URL hinzu:
   ```
   https://github.com/YOUR_GITHUB_USER/unifi-protect-talkback-ha
   ```
4. Schließe den Dialog. Das Add-on **UniFi Protect Doorbell** erscheint nun im Store.
5. Klicke auf das Add-on und dann auf **Installieren**.

## Konfiguration

Öffne den Reiter **Konfiguration** des Add-ons und passe die Felder an:

| Option | Beschreibung | Pflicht |
|---|---|---|
| `unifi_host` | IP-Adresse oder Hostname des UniFi Protect NVR | ✓ |
| `unifi_port` | HTTPS-Port des NVR (Standard: 443) | |
| `unifi_username` | Benutzername für den Protect-Login | ✓ |
| `unifi_password` | Passwort für den Protect-Login | ✓ |
| `unifi_camera_id` | ID der Türklingel-Kamera (24-stellige Hex-ID) | ✓ |
| `web_port` | Port der Weboberfläche (Standard: 8080) | |
| `ssl` | HTTPS für die Weboberfläche aktivieren | |
| `certfile` | Zertifikatsdatei aus `/ssl/` (z. B. `fullchain.pem`) | |
| `keyfile` | Schlüsseldatei aus `/ssl/` (z. B. `privkey.pem`) | |
| `log_level` | Protokollierungsstufe: `debug`, `info`, `warning`, `error` | |

### Kamera-ID ermitteln

Die Kamera-ID ist die interne 24-stellige ID in UniFi Protect.  
Sie lässt sich über die UniFi Protect API abrufen:

```
https://<NVR-IP>/proxy/protect/api/cameras
```

Alternativ ist sie in der URL sichtbar, wenn man die Kamera in der Protect-Weboberfläche öffnet.

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

Nach dem Start ist die Weboberfläche erreichbar unter:

```
http://<Home-Assistant-IP>:<web_port>
```

Standardmäßig: `http://<HA-IP>:8080`

Bei aktiviertem SSL:

```
https://<Home-Assistant-IP>:<web_port>
```

## Funktionsumfang

- **Livebild**: RTSP-Stream der Türklingel (HLS, ~3 s Verzögerung)
- **Talkback**: Sprechen über den Lautsprecher der Türklingel (WebSocket)
- **Display-Nachrichten**: Text auf dem LCD-Display der Türklingel anzeigen
- **Klingelton-Steuerung**: Klingelton und Lautstärke der Türklingel sowie eines angeschlossenen PoE-Chimes einstellen
- **Lautstärke**: Lautsprecher- und Mikrofonlautstärke der Kamera anpassen

## Troubleshooting

**Add-on startet nicht**
- Prüfe im Protokoll die Fehlermeldung.
- Stelle sicher, dass `unifi_host`, `unifi_username` und `unifi_camera_id` gesetzt sind.

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
- Das Add-on akzeptiert selbstsignierte Zertifikate des NVR automatisch.
- Prüfe Benutzername und Passwort in der Konfiguration.
