import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import type { AxiosInstance } from "axios";
import {
  getTalkbackWsUrl,
  getCameras,
  getCameraDetails,
  updateCameraSettings,
  setDisplayMessage,
  getRingtones,
  getChimeDevices,
  updateChimeDevice,
} from "./protect-client.js";
import type { ProtectSession, Camera, CameraDetails, Ringtone, ChimeDevice } from "./protect-client.js";

const HTML_PATH = path.join(process.cwd(), "web", "index.html");
const HLS_DIR = path.join(os.tmpdir(), "protect-hls");

fs.mkdirSync(HLS_DIR, { recursive: true });

export type DiscoveryOptions = {
  cameraId?: string;
  doorbellName?: string;
  doorbellMac?: string;
};

function inputFormat(mimeType: string): string {
  return mimeType.startsWith("audio/ogg") ? "ogg" : "webm";
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(data) as Record<string, unknown>); }
      catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

class HlsManager {
  private proc: ChildProcess | null = null;
  private _ready = false;
  private _error: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private rtspUrl: string, private hlsDir: string) {}

  start(): void {
    if (this.proc) return;
    this.spawn();
  }

  private spawn(): void {
    const m3u8 = path.join(this.hlsDir, "stream.m3u8");
    const segPattern = path.join(this.hlsDir, "seg%03d.ts");

    this.proc = spawn("ffmpeg", [
      "-hide_banner", "-nostats",
      "-rtsp_transport", "tcp",
      "-i", this.rtspUrl,
      "-vcodec", "copy",
      "-acodec", "aac", "-ar", "44100", "-ac", "2",
      "-f", "hls",
      "-hls_time", "1",
      "-hls_list_size", "4",
      "-hls_flags", "delete_segments+temp_file",
      "-hls_segment_filename", segPattern,
      "-y", m3u8,
    ]);

    this.proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (/error|failed|invalid/i.test(line) && !/size=|time=/i.test(line)) {
        console.error("[hls]", line);
        this._error = line;
      }
      if (line.includes("m3u8") && line.includes("Opening")) {
        this._ready = true;
        this._error = null;
      }
    });

    this.proc.on("close", (code) => {
      console.log(`[hls] ffmpeg exit ${code}`);
      this.proc = null;
      this._ready = false;
      if (code !== 0 && code !== null) {
        this._error = `ffmpeg exited (${code})`;
        this.restartTimer = setTimeout(() => this.spawn(), 8000);
      }
    });

    console.log("[hls] starting ffmpeg RTSP→HLS");
  }

  stop(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.proc?.kill("SIGTERM");
    this.proc = null;
    this._ready = false;
  }

  isReady(): boolean {
    return this._ready && fs.existsSync(path.join(this.hlsDir, "stream.m3u8"));
  }

  getError(): string | null { return this._error; }
}

export function startServer(
  session: ProtectSession,
  client: AxiosInstance,
  serverPort = 8080,
  discovery: DiscoveryOptions = {}
): void {
  const timesliceMs = parseInt(process.env["MEDIA_RECORDER_TIMESLICE_MS"] ?? "500", 10);
  const useHttps = process.env["HTTPS"] === "1";
  const protectHost = process.env["PROTECT_HOST"] ?? "";

  // ── Discovery state ──────────────────────────────────────────────────────────
  let allCameras: Camera[] = [];
  let doorbells: Camera[] = [];
  let activeCameraId: string | null = null;

  // ── Per-camera state ─────────────────────────────────────────────────────────
  let cameraDetails: CameraDetails | null = null;
  let cameraDetailsError: string | null = null;
  let hls: HlsManager | null = null;
  let ringtones: Ringtone[] = [];
  let chimeDevices: ChimeDevice[] = [];

  const loadCameraDetails = async (): Promise<void> => {
    if (!activeCameraId) return;
    try {
      cameraDetails = await getCameraDetails(client, session, activeCameraId);
      const f = cameraDetails.featureFlags;
      console.log(`[server] camera: ${cameraDetails.name} | hasSpeaker=${f.hasSpeaker} hasLcdScreen=${f.hasLcdScreen}`);
      cameraDetailsError = null;
    } catch (err) {
      cameraDetailsError = err instanceof Error ? err.message : String(err);
      console.error("[server] getCameraDetails:", cameraDetailsError);
    }
  };

  const startHls = (): void => {
    if (!activeCameraId) return;
    const channels = cameraDetails?.channels ?? [];
    const channel = channels.find((c) => c.isRtspEnabled) ?? channels[0];
    if (!channel?.rtspAlias || !protectHost) {
      console.warn("[hls] no RTSP channel or host configured");
      return;
    }
    const user = encodeURIComponent(process.env["PROTECT_USERNAME"] ?? "");
    const pass = encodeURIComponent(process.env["PROTECT_PASSWORD"] ?? "");
    const auth = user && pass ? `${user}:${pass}@` : "";
    const rtspUrl = `rtsp://${auth}${protectHost}:7447/${channel.rtspAlias}`;
    console.log(`[hls] RTSP channel: ${channel.name} (${channel.width}x${channel.height})`);
    hls = new HlsManager(rtspUrl, HLS_DIR);
    hls.start();
  };

  const loadChimeData = async (): Promise<void> => {
    if (!activeCameraId) return;
    try {
      [ringtones, chimeDevices] = await Promise.all([
        getRingtones(client, session),
        getChimeDevices(client, session),
      ]);
      console.log(`[server] ringtones: ${ringtones.length} | chimes: ${chimeDevices.length}`);
    } catch (err) {
      console.error("[server] loadChimeData:", err instanceof Error ? err.message : err);
    }
  };

  const activateCamera = (): void => {
    void loadCameraDetails().then(() => startHls());
    void loadChimeData();
  };

  // ── Auto-discovery ───────────────────────────────────────────────────────────
  const discoverDoorbell = async (): Promise<void> => {
    try {
      allCameras = await getCameras(client, session);
      console.log(`[discovery] ${allCameras.length} device(s) found:`);
      for (const c of allCameras) {
        console.log(`[discovery]   ${c.id}  "${c.name}"  type=${c.type}  model=${c.model}  isDoorbell=${c.isDoorbell}  mac=${c.mac}`);
      }

      // Resolve manual selector: match ID first, then name/marketName, then MAC
      if (discovery.cameraId) {
        const selector = discovery.cameraId.trim();
        console.log(`[discovery] configured selector: "${selector}"`);

        let matched = allCameras.find((c) => c.id === selector);
        let matchedBy = "id";

        if (!matched) {
          matched = allCameras.find(
            (c) =>
              c.name.toLowerCase() === selector.toLowerCase() ||
              c.marketName.toLowerCase() === selector.toLowerCase(),
          );
          if (matched) matchedBy = "name";
        }

        if (!matched) {
          const norm = selector.toLowerCase().replace(/[:\-]/g, "");
          matched = allCameras.find((c) => c.mac.toLowerCase().replace(/[:\-]/g, "") === norm);
          if (matched) matchedBy = "mac";
        }

        if (matched) {
          activeCameraId = matched.id;
          console.log(`[discovery] matched camera id:   ${matched.id}`);
          console.log(`[discovery] matched camera name: "${matched.name}"`);
          console.log(`[discovery] matched by:          ${matchedBy}`);
          return;
        }
        console.warn(`[discovery] selector "${selector}" matched no camera — falling through to auto-discovery`);
      }

      let candidates = allCameras.filter((c) => c.isDoorbell);

      if (discovery.doorbellName) {
        const name = discovery.doorbellName.toLowerCase();
        candidates = candidates.filter((c) => c.name.toLowerCase().includes(name));
        console.log(`[discovery] filter by name "${discovery.doorbellName}": ${candidates.length} match(es)`);
      }
      if (discovery.doorbellMac) {
        const mac = discovery.doorbellMac.toLowerCase().replace(/[:\-]/g, "");
        candidates = candidates.filter((c) => c.mac.toLowerCase().replace(/[:\-]/g, "") === mac);
        console.log(`[discovery] filter by MAC "${discovery.doorbellMac}": ${candidates.length} match(es)`);
      }

      doorbells = candidates;

      if (candidates.length === 1) {
        const chosen = candidates[0]!;
        activeCameraId = chosen.id;
        console.log(`[discovery] auto-selected: "${chosen.name}" (${activeCameraId})`);
      } else if (candidates.length > 1) {
        console.log(`[discovery] ${candidates.length} doorbells found — waiting for user selection`);
      } else {
        console.warn(`[discovery] no doorbell detected among ${allCameras.length} device(s)`);
      }
    } catch (err) {
      console.error("[discovery] failed:", err instanceof Error ? err.message : err);
    }
  };

  void discoverDoorbell().then(() => {
    if (activeCameraId) activateCamera();
  });

  // Reload periodically
  setInterval(() => {
    if (activeCameraId) {
      void loadCameraDetails();
      void loadChimeData();
    }
  }, 30_000);

  // ── Request handler ──────────────────────────────────────────────────────────
  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // HTML pages — frame-ancestors * allows embedding in HA panel_iframe / dashboard
    if (method === "GET" && (url === "/" || url === "/index.html" || url === "/push-to-talk.html")) {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "frame-ancestors *",
      });
      res.end(fs.readFileSync(HTML_PATH));
      return;
    }

    if (method === "GET" && url === "/config.json") {
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ timesliceMs }));
      return;
    }

    // HLS playlist
    if (method === "GET" && url === "/hls/stream.m3u8") {
      const m3u8 = path.join(HLS_DIR, "stream.m3u8");
      if (!fs.existsSync(m3u8)) {
        res.writeHead(503, { "Retry-After": "3" }); res.end("Stream not ready");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(fs.readFileSync(m3u8));
      return;
    }

    // HLS segments — regex prevents path traversal
    const segMatch = url.match(/^\/hls\/(seg\d{3}\.ts)$/);
    if (method === "GET" && segMatch?.[1]) {
      const segFile = path.join(HLS_DIR, segMatch[1]);
      if (!fs.existsSync(segFile)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
      });
      fs.createReadStream(segFile).pipe(res);
      return;
    }

    // ── Device discovery API ─────────────────────────────────────────────────

    if (url === "/api/devices" && method === "GET") {
      json(res, {
        devices: allCameras.map((c) => ({
          id: c.id,
          name: c.name,
          model: c.model,
          marketName: c.marketName,
          mac: c.mac,
          host: c.host,
          isDoorbell: c.isDoorbell,
          selected: c.id === activeCameraId,
        })),
        doorbells: doorbells.map((c) => c.id),
        activeCameraId,
      });
      return;
    }

    if (url === "/api/devices/select" && method === "POST") {
      const body = await parseBody(req);
      const id = typeof body["id"] === "string" ? body["id"] : null;
      const mac = typeof body["mac"] === "string" ? body["mac"] : null;

      let target: Camera | undefined;
      if (id) {
        target = allCameras.find((c) => c.id === id);
      } else if (mac) {
        const norm = mac.toLowerCase().replace(/[:\-]/g, "");
        target = allCameras.find((c) => c.mac.toLowerCase().replace(/[:\-]/g, "") === norm);
      }

      if (!target) {
        json(res, { error: "Device not found" }, 404); return;
      }

      activeCameraId = target.id;
      console.log(`[discovery] user selected: "${target.name}" (${activeCameraId})`);

      hls?.stop();
      hls = null;
      cameraDetails = null;
      cameraDetailsError = null;

      activateCamera();
      json(res, { ok: true, id: target.id, name: target.name });
      return;
    }

    // ── Camera API ───────────────────────────────────────────────────────────

    if (url === "/api/status" && method === "GET") {
      json(res, {
        nvr: { connected: !!activeCameraId && !cameraDetailsError, error: cameraDetailsError },
        camera: cameraDetails
          ? { id: cameraDetails.id, name: cameraDetails.name, type: cameraDetails.type, state: cameraDetails.state }
          : null,
        stream: { hlsReady: hls?.isReady() ?? false, hlsError: hls?.getError() ?? null },
        activeCameraId,
      });
      return;
    }

    if (url === "/api/camera/stream-info" && method === "GET") {
      if (!cameraDetails) {
        json(res, { error: cameraDetailsError ?? "Camera not loaded" }, 503); return;
      }
      const enabledChannels = cameraDetails.channels.filter((c) => c.isRtspEnabled);
      json(res, {
        channels: enabledChannels,
        hlsUrl: enabledChannels.length > 0 ? "/hls/stream.m3u8" : null,
        hlsReady: hls?.isReady() ?? false,
      });
      return;
    }

    if (url === "/api/settings" && method === "GET") {
      await loadCameraDetails();
      if (!cameraDetails) {
        json(res, { error: cameraDetailsError ?? "Camera not loaded" }, 503); return;
      }
      json(res, {
        speakerSettings: cameraDetails.speakerSettings,
        micVolume: cameraDetails.micVolume,
        lcdMessage: cameraDetails.lcdMessage,
        featureFlags: cameraDetails.featureFlags,
      });
      return;
    }

    if (url === "/api/settings" && method === "POST") {
      if (!activeCameraId) { json(res, { error: "No doorbell selected" }, 503); return; }
      const body = await parseBody(req);
      try {
        await updateCameraSettings(client, session, activeCameraId, body);
        await loadCameraDetails();
        json(res, { ok: true });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return;
    }

    if (url === "/api/display-message" && method === "POST") {
      if (!activeCameraId) { json(res, { error: "No doorbell selected" }, 503); return; }
      const body = await parseBody(req);
      const message = (body["message"] ?? null) as { type: string; text?: string } | null;
      try {
        await setDisplayMessage(client, session, activeCameraId, message);
        await loadCameraDetails();
        json(res, { ok: true });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return;
    }

    // Ringtone audio proxy — streams MP3 from NVR without exposing credentials
    const audioMatch = url.match(/^\/api\/ringtone-audio\/([a-f0-9]{24})$/);
    if (method === "GET" && audioMatch?.[1]) {
      try {
        const audioRes = await client.get(
          `/proxy/protect/api/ringtones/${audioMatch[1]}`,
          {
            headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
            responseType: "arraybuffer",
          }
        );
        const raw = audioRes.data as ArrayBuffer | Buffer;
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        const ct = (audioRes.headers["content-type"] as string | undefined) ?? "audio/mpeg";
        res.writeHead(200, {
          "Content-Type": ct,
          "Content-Length": String(data.length),
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(data);
      } catch (err) {
        console.error("[server] ringtone-audio proxy error:", err instanceof Error ? err.message : err);
        res.writeHead(404); res.end();
      }
      return;
    }

    if (url === "/api/chime-settings" && method === "GET") {
      await loadChimeData();
      const sp = cameraDetails?.speakerSettings ?? null;

      const chimesForCamera = chimeDevices.map((ch) => ({
        id: ch.id,
        name: ch.name,
        type: ch.type,
        state: ch.state,
        masterVolume: ch.volume,
        masterRepeatTimes: ch.repeatTimes,
        cameraRing: ch.ringSettings.find((r) => r.cameraId === activeCameraId) ?? null,
        supportCustomRingtone: ch.featureFlags.supportCustomRingtone,
      }));

      json(res, {
        doorbellRing: sp
          ? {
              ringVolume: sp.ringVolume,
              ringtoneId: sp.ringtoneId,
              repeatTimes: sp.repeatTimes,
              supportCustomRingtone: cameraDetails?.featureFlags.supportCustomRingtone ?? false,
            }
          : null,
        ringtones,
        chimes: chimesForCamera,
      });
      return;
    }

    if (url === "/api/chime-settings" && method === "POST") {
      if (!activeCameraId) { json(res, { error: "No doorbell selected" }, 503); return; }
      const body = await parseBody(req);
      const errors: string[] = [];

      if (body["doorbellRing"]) {
        const dr = body["doorbellRing"] as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if (typeof dr["ringVolume"] === "number") patch["ringVolume"] = dr["ringVolume"];
        if (typeof dr["ringtoneId"] === "string") patch["ringtoneId"] = dr["ringtoneId"];
        if (typeof dr["repeatTimes"] === "number") patch["repeatTimes"] = dr["repeatTimes"];
        if (Object.keys(patch).length > 0) {
          try {
            await updateCameraSettings(client, session, activeCameraId, { speakerSettings: patch });
          } catch (err) {
            errors.push(`doorbell: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (body["chimeId"] && body["chimeRing"]) {
        const chimeId = String(body["chimeId"]);
        const cr = body["chimeRing"] as Record<string, unknown>;
        const chime = chimeDevices.find((c) => c.id === chimeId);
        if (chime) {
          const existingRs = chime.ringSettings.find((r) => r.cameraId === activeCameraId);
          const updatedRs = {
            cameraId: activeCameraId,
            volume: typeof cr["cameraVolume"] === "number" ? cr["cameraVolume"] : (existingRs?.volume ?? 100),
            ringtoneId: typeof cr["ringtoneId"] === "string" ? cr["ringtoneId"] : (existingRs?.ringtoneId ?? ""),
            repeatTimes: typeof cr["repeatTimes"] === "number" ? cr["repeatTimes"] : (existingRs?.repeatTimes ?? 1),
          };
          const newRingSettings = chime.ringSettings
            .filter((r) => r.cameraId !== activeCameraId)
            .concat(updatedRs);

          const chimePatch: Record<string, unknown> = { ringSettings: newRingSettings };
          if (typeof cr["masterVolume"] === "number") chimePatch["volume"] = cr["masterVolume"];
          if (typeof cr["masterRepeatTimes"] === "number") chimePatch["repeatTimes"] = cr["masterRepeatTimes"];

          try {
            await updateChimeDevice(client, session, chimeId, chimePatch);
          } catch (err) {
            errors.push(`chime: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      await loadChimeData();
      await loadCameraDetails();

      json(res, errors.length > 0 ? { ok: false, errors } : { ok: true });
      return;
    }

    // ── Debug ─────────────────────────────────────────────────────────────────

    if (url === "/api/debug/devices" && method === "GET") {
      try {
        // Use cached allCameras + chimes if available, otherwise fetch fresh
        const [cameras, chimes] = allCameras.length > 0
          ? [allCameras, chimeDevices]
          : await Promise.all([getCameras(client, session), getChimeDevices(client, session)]);

        const devices = [
          ...cameras.map((c) => ({
            id: c.id, name: c.name, type: c.type, model: c.model, marketName: c.marketName,
            mac: c.mac, host: c.host, isDoorbell: c.isDoorbell,
          })),
          ...chimes.map((c) => ({
            id: c.id, name: c.name, type: c.type, model: "", marketName: "",
            mac: "", host: "", isDoorbell: false,
          })),
        ];
        json(res, { devices });
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return;
    }

    res.writeHead(404); res.end();
  };

  const requestHandler: http.RequestListener = (req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      console.error("[server] request error:", err instanceof Error ? err.message : err);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    });
  };

  const httpServer = useHttps
    ? https.createServer(
        {
          key: fs.readFileSync(process.env["SSL_KEY"] ?? "certs/key.pem"),
          cert: fs.readFileSync(process.env["SSL_CERT"] ?? "certs/cert.pem"),
        },
        requestHandler
      )
    : http.createServer(requestHandler);

  const proto = useHttps ? "https" : "http";
  if (useHttps) console.log("[server] HTTPS enabled");

  // ── WebSocket talkback ───────────────────────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: "/audio" });
  let sessionActive = false;

  wss.on("connection", (browserWs) => {
    if (sessionActive) {
      console.log("[server] busy — rejecting connection");
      browserWs.close(1008, "busy");
      return;
    }
    if (!activeCameraId) {
      browserWs.close(1011, "no doorbell selected");
      return;
    }
    sessionActive = true;
    console.log("[server] browser connected");

    const cameraIdSnapshot = activeCameraId;
    let ffmpeg: ReturnType<typeof spawn> | null = null;
    let talkbackWs: WebSocket | null = null;
    let sessionStart = 0;
    let browserChunks = 0;

    const endSession = (reason: string): void => {
      const durationMs = sessionStart ? Date.now() - sessionStart : 0;
      console.log(`[server] session ended: ${reason} | browserChunks=${browserChunks} duration=${durationMs}ms`);
      ffmpeg?.stdin?.end();
      sessionActive = false;
    };

    const startPipeline = async (mimeType: string): Promise<void> => {
      const fmt = inputFormat(mimeType);
      console.log(`[server] init mimeType=${mimeType} → ffmpeg -f ${fmt}`);
      try {
        const talkbackUrl = await getTalkbackWsUrl(client, session, cameraIdSnapshot);
        talkbackWs = new WebSocket(talkbackUrl, {
          rejectUnauthorized: false,
          headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
        });
        talkbackWs.on("open", () => console.log("[server] talkback WS open"));
        talkbackWs.on("close", (code) => console.log(`[server] talkback closed (${code})`));
        talkbackWs.on("error", (e) => console.error("[server] talkback error:", e.message));

        ffmpeg = spawn("ffmpeg", [
          "-hide_banner", "-nostats",
          "-f", fmt, "-i", "pipe:0",
          "-acodec", "aac", "-ar", "22050", "-ac", "1", "-b:a", "64k",
          "-flags", "+global_header", "-f", "adts", "pipe:1",
        ]);

        let chunksSent = 0;
        ffmpeg.stdout?.on("data", (chunk: Buffer) => {
          if (talkbackWs?.readyState === WebSocket.OPEN) { talkbackWs.send(chunk); chunksSent++; }
        });
        ffmpeg.stderr?.on("data", (d: Buffer) => {
          const line = d.toString().trim();
          if (/error|invalid|failed/i.test(line)) console.error("[ffmpeg]", line);
        });
        ffmpeg.on("close", (code) => {
          const durationMs = sessionStart ? Date.now() - sessionStart : 0;
          console.log(`[server] ffmpeg exit=${code} | adts-chunks=${chunksSent} browser-chunks=${browserChunks} duration=${durationMs}ms`);
          talkbackWs?.close(1000, "done");
        });
      } catch (err) {
        console.error("[server] pipeline error:", err instanceof Error ? err.message : err);
        browserWs.close(1011, "pipeline error");
        sessionActive = false;
      }
    };

    let initialized = false;
    browserWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        if (initialized) return;
        initialized = true;
        try {
          const msg = JSON.parse(data.toString()) as { type?: string; mimeType?: string };
          sessionStart = Date.now();
          void startPipeline(msg.mimeType ?? "audio/webm");
        } catch { void startPipeline("audio/webm"); }
        return;
      }
      browserChunks++;
      if (ffmpeg?.stdin?.writable) ffmpeg.stdin.write(data as Buffer);
    });

    browserWs.on("close", () => endSession("browser disconnected"));
    browserWs.on("error", (e) => endSession(`browser error: ${e.message}`));
  });

  // Cleanup on exit
  process.on("SIGTERM", () => { hls?.stop(); process.exit(0); });
  process.on("SIGINT", () => { hls?.stop(); process.exit(0); });

  httpServer.listen(serverPort, () => {
    console.log(`[server] ${proto}://localhost:${serverPort}`);
  });
}
