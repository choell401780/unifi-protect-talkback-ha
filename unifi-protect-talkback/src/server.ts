import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
// HLS uses an on-disk segment dir. MSE is in-memory only (no temp files).
// Keeping HLS isolated under its own directory means MSE-mode cannot pollute
// or be affected by stale .ts/.m3u8 files from a previous run.
const HLS_DIR = path.join(os.tmpdir(), "protect-hls");

fs.mkdirSync(HLS_DIR, { recursive: true });

// Kill any leftover ffmpeg from a previous (crashed/killed) run that still
// writes into OUR HLS_DIR. This is the root cause of "failed to rename
// stream.m3u8.tmp" — two ffmpeg processes racing on the same files.
// We match by full command line to avoid touching unrelated ffmpegs.
function killStaleFfmpegs(): void {
  try {
    const r = spawnSync("pgrep", ["-f", HLS_DIR], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return;
    const pids = r.stdout.trim().split("\n").map((s) => parseInt(s, 10)).filter((n) => n > 0);
    if (pids.length === 0) return;
    console.warn(`[server] found ${pids.length} stale ffmpeg process(es) writing to ${HLS_DIR} — terminating: ${pids.join(", ")}`);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    }
    // Brief grace period, then SIGKILL anyone still alive
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const alive = pids.filter((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      if (alive.length === 0) break;
      spawnSync("sleep", ["0.1"]);
    }
    for (const pid of pids) {
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); console.warn(`[server] SIGKILL ${pid}`); }
      catch { /* already gone, fine */ }
    }
  } catch (e) {
    console.warn(`[server] stale-ffmpeg check skipped:`, e instanceof Error ? e.message : e);
  }
}
killStaleFfmpegs();

// Wipe any leftover segments from a previous (possibly crashed) ffmpeg.
// Now safe because the previous ffmpeg (if any) was just terminated.
try {
  const stale = fs.readdirSync(HLS_DIR).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".m3u8") || f.endsWith(".tmp")
  );
  for (const f of stale) {
    try { fs.unlinkSync(path.join(HLS_DIR, f)); } catch { /* race ok */ }
  }
  if (stale.length > 0) console.log(`[server] HLS_DIR=${HLS_DIR} cleaned (${stale.length} stale files on startup)`);
} catch (e) {
  console.warn(`[server] HLS_DIR initial cleanup skipped:`, e instanceof Error ? e.message : e);
}

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

// Same-origin by default: API is consumed only by the bundled web UI
// (served from the same server) or through Home Assistant Ingress.
// Cross-origin access can be opted in via CORS_ALLOW_ORIGIN env var
// (e.g. "http://homeassistant.local:8123" or "*" for legacy/dev setups).
const CORS_ALLOW_ORIGIN = (process.env["CORS_ALLOW_ORIGIN"] ?? "").trim();

function setCorsHeaders(res: http.ServerResponse): void {
  if (!CORS_ALLOW_ORIGIN) return;
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  setCorsHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Low-latency HLS knobs — overridable via env for differing camera GOP / hardware.
const HLS_ANALYZEDURATION = process.env["HLS_ANALYZEDURATION"] ?? "1000000"; // 1s
const HLS_PROBESIZE = process.env["HLS_PROBESIZE"] ?? "500000";              // 500KB
const HLS_RTSP_TRANSPORT = process.env["HLS_RTSP_TRANSPORT"] ?? "tcp";       // tcp = stable

// Opt-in video re-encode for cameras with long GOP (e.g. G4 Doorbell @ 5s GOP).
// When enabled, ffmpeg forces 1s keyframes → playable segments at the configured
// hls_time. Costs CPU; default off to stay stable on weak hardware.
const HLS_REENCODE = process.env["HLS_REENCODE"] === "1";

// LL-HLS (low_latency flag + fMP4) requires re-encode to guarantee sub-second GOPs.
// Without re-encode the camera's GOP (~5 s) makes LL-HLS pointless, so LL is only
// activated when HLS_REENCODE is set.
const HLS_LL = HLS_REENCODE; // true → LL-HLS (fMP4, 0.5 s segments, low_latency)
const HLS_TIME = process.env["HLS_TIME"] ?? (HLS_LL ? "0.5" : "1");
const HLS_LIST_SIZE = process.env["HLS_LIST_SIZE"] ?? (HLS_LL ? "4" : "3"); // 4×0.5 s = 2 s window
const HLS_VIDEO_BITRATE = process.env["HLS_VIDEO_BITRATE"] ?? "2M";
const HLS_PRESET = process.env["HLS_PRESET"] ?? "veryfast";   // x264 preset
// Hardware acceleration scaffolding — "none" = software libx264 (default, stable).
// Other values prepare ffmpeg pipelines but are NOT validated on every host;
// users opt-in explicitly when their container has the necessary devices.
const HLS_HWACCEL = (process.env["HLS_HWACCEL"] ?? "none").toLowerCase();
type HwAccel = "none" | "vaapi" | "qsv" | "nvenc";
const VALID_HWACCEL: ReadonlySet<HwAccel> = new Set(["none", "vaapi", "qsv", "nvenc"]);
const hwaccel: HwAccel = VALID_HWACCEL.has(HLS_HWACCEL as HwAccel)
  ? (HLS_HWACCEL as HwAccel)
  : "none";

// Encoder-args by hwaccel mode. Each block returns:
//   inputFlags  — placed BEFORE `-i` (e.g. -hwaccel vaapi)
//   videoArgs   — placed AFTER  `-i` (encoder + GOP control)
// Software (libx264) is the only path validated in the default release;
// hwaccel branches are prepared for users with capable hosts.
function buildEncoderArgs(): { inputFlags: string[]; videoArgs: string[] } {
  if (!HLS_REENCODE) {
    return { inputFlags: [], videoArgs: ["-vcodec", "copy"] };
  }
  const forceKey = `expr:gte(t,n_forced*${HLS_TIME})`;

  switch (hwaccel) {
    case "vaapi":
      return {
        inputFlags: [
          "-hwaccel", "vaapi",
          "-hwaccel_device", "/dev/dri/renderD128",
          "-hwaccel_output_format", "vaapi",
        ],
        videoArgs: [
          "-vf", "format=nv12|vaapi,hwupload",
          "-vcodec", "h264_vaapi",
          "-profile:v", "constrained_baseline",
          "-force_key_frames", forceKey,
          "-b:v", HLS_VIDEO_BITRATE,
          "-maxrate", HLS_VIDEO_BITRATE,
        ],
      };
    case "qsv":
      return {
        inputFlags: ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"],
        videoArgs: [
          "-vcodec", "h264_qsv",
          "-preset", HLS_PRESET,
          "-profile:v", "baseline",
          "-force_key_frames", forceKey,
          "-b:v", HLS_VIDEO_BITRATE,
          "-maxrate", HLS_VIDEO_BITRATE,
        ],
      };
    case "nvenc":
      return {
        inputFlags: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
        videoArgs: [
          "-vcodec", "h264_nvenc",
          "-preset", "p3",       // p1 (fastest) … p7 (slowest), p3 ≈ "fast"
          "-tune", "ll",         // low-latency
          "-profile:v", "baseline",
          "-force_key_frames", forceKey,
          "-b:v", HLS_VIDEO_BITRATE,
          "-maxrate", HLS_VIDEO_BITRATE,
        ],
      };
    case "none":
    default:
      return {
        inputFlags: [],
        videoArgs: [
          "-vcodec", "libx264",
          "-preset", HLS_PRESET,
          "-tune", "zerolatency",
          "-profile:v", "baseline",
          "-refs", "1",
          "-pix_fmt", "yuv420p",
          "-force_key_frames", forceKey,
          "-sc_threshold", "0",
          "-b:v", HLS_VIDEO_BITRATE,
          "-maxrate", HLS_VIDEO_BITRATE,
          "-bufsize", HLS_VIDEO_BITRATE,
        ],
      };
  }
}

class HlsManager {
  private proc: ChildProcess | null = null;
  private _ready = false;
  private _error: string | null = null;
  private _startedAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  // Set true once stop() is called — prevents the close-handler auto-restart
  // from firing on a SIGTERM that we ourselves sent.
  private stopping = false;

  constructor(private rtspUrl: string, private hlsDir: string) {}

  start(): void {
    if (this.proc) {
      console.log(`[hls] start() ignored — ffmpeg already running (pid=${this.proc.pid})`);
      return;
    }
    this.stopping = false;
    // Cancel a pending auto-restart so start() + timer don't both call spawn() concurrently
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.spawn();
  }

  private spawn(): void {
    if (this.proc) {
      console.warn(`[hls] spawn() skipped — ffmpeg already running (pid=${this.proc.pid})`);
      return;
    }
    // Defensive: clear any leftover segments before starting the new ffmpeg
    // (prevents "failed to rename .tmp" / "failed to delete old segment" races
    // when a previous process was still terminating).
    HlsManager.cleanupDir(this.hlsDir);

    const m3u8 = path.join(this.hlsDir, "stream.m3u8");
    const segExt = HLS_LL ? "m4s" : "ts";
    const segPattern = path.join(this.hlsDir, `seg%03d.${segExt}`);

    const { inputFlags, videoArgs } = buildEncoderArgs();

    const args = [
      "-hide_banner", "-nostats",
      // ── Input: low-latency demux ───────────────────────────────────────────
      "-fflags", "nobuffer+flush_packets",
      "-flags", "low_delay",
      ...inputFlags,
      "-rtsp_transport", HLS_RTSP_TRANSPORT,
      "-analyzeduration", HLS_ANALYZEDURATION,
      "-probesize", HLS_PROBESIZE,
      "-i", this.rtspUrl,
      // ── Output: video (copy or re-encode), audio always AAC ────────────────
      ...videoArgs,
      "-acodec", "aac", "-ar", "44100", "-ac", "2",
      "-max_delay", "500000",
      // ── HLS muxer ─────────────────────────────────────────────────────────
      "-f", "hls",
      "-hls_time", HLS_TIME,
      "-hls_list_size", HLS_LIST_SIZE,
      ...(HLS_LL ? [
        "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", "init.mp4",
        "-hls_flags", "delete_segments+temp_file+independent_segments",
      ] : [
        "-hls_flags", "delete_segments+temp_file+independent_segments",
      ]),
      "-hls_segment_filename", segPattern,
      "-y", m3u8,
    ];

    // Redact RTSP credentials in log
    const redacted = args.map((a) => a.replace(/rtsp:\/\/[^@]+@/, "rtsp://***@"));
    console.log(`[hls] ffmpeg ${redacted.join(" ")}`);
    const targetLatency = (parseFloat(HLS_TIME) * parseInt(HLS_LIST_SIZE, 10)).toFixed(1);
    const encoderLabel = HLS_REENCODE
      ? `re-encode (codec=${hwaccel === "none" ? "libx264" : `h264_${hwaccel}`}, preset=${HLS_PRESET}, bitrate=${HLS_VIDEO_BITRATE}, hwaccel=${hwaccel}, gop=${HLS_TIME}s)`
      : "copy (no re-encode, GOP follows source)";
    console.log(`[hls] mode: ${encoderLabel}`);
    console.log(`[hls] segments: type=${HLS_LL ? "fMP4 (LL-HLS)" : "MPEG-TS"} time=${HLS_TIME}s list=${HLS_LIST_SIZE} → ~${targetLatency}s window`);
    console.log(`[hls] latency strategy: ${HLS_LL ? "short-segment fMP4 (0.5 s GOP, fMP4 segments) → target ~1–2 s" : HLS_REENCODE ? "low (1 s GOP, TS segments) → ~2–3 s" : "stable (copy, GOP follows camera ~5 s) → ~10 s"}`);

    this._startedAt = Date.now();
    this.proc = spawn("ffmpeg", args);
    const procPid = this.proc.pid;
    console.log(`[hls] ffmpeg started (pid=${procPid})`);

    this.proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (/error|failed|invalid/i.test(line) && !/size=|time=/i.test(line)) {
        console.error("[hls]", line);
        this._error = line;
      }
      if (line.includes("Opening") && line.includes("init.mp4")) {
        console.log(`[hls] LL-HLS init segment written (fMP4 ready)`);
      }
      if (line.includes("Opening") && line.includes("m3u8")) {
        if (!this._ready) {
          const startupMs = Date.now() - this._startedAt;
          console.log(`[hls] first playlist ready after ${startupMs}ms${HLS_LL ? " [LL-HLS]" : ""}`);
        }
        this._ready = true;
        this._error = null;
      }
    });

    this.proc.on("close", (code) => {
      console.log(`[hls] ffmpeg exit ${code} (pid=${procPid})`);
      this.proc = null;
      this._ready = false;
      if (!this.stopping && code !== 0 && code !== null) {
        this._error = `ffmpeg exited (${code})`;
        console.log(`[hls] scheduling restart in 8s`);
        this.restartTimer = setTimeout(() => this.spawn(), 8000);
      }
    });

    console.log(`[hls] starting ffmpeg RTSP→HLS (transport=${HLS_RTSP_TRANSPORT})`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const proc = this.proc;
    this.proc = null;
    this._ready = false;
    if (proc) {
      const pid = proc.pid;
      console.log(`[hls] stopping ffmpeg (pid=${pid})`);
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => { if (!done) { done = true; resolve(); } };
        proc.once("exit", finish);
        proc.once("close", finish);
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        // Escalate to SIGKILL if SIGTERM didn't take in 2s
        setTimeout(() => {
          if (!done) {
            console.warn(`[hls] SIGTERM timed out (pid=${pid}), sending SIGKILL`);
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          }
        }, 2000);
        // Hard ceiling — never block longer than 5s
        setTimeout(finish, 5000);
      });
      console.log(`[hls] ffmpeg stopped (pid=${pid})`);
    }
    HlsManager.cleanupDir(this.hlsDir);
  }

  // Remove leftover .ts/.m3u8/.tmp files. Called on stop and before each start
  // so the new ffmpeg process gets a clean working directory.
  static cleanupDir(dir: string): void {
    try {
      const files = fs.readdirSync(dir);
      let removed = 0;
      for (const f of files) {
        if (f.endsWith(".ts") || f.endsWith(".m4s") || f.endsWith(".mp4") || f.endsWith(".m3u8") || f.endsWith(".tmp") || f.endsWith(".m3u8.tmp")) {
          try { fs.unlinkSync(path.join(dir, f)); removed++; } catch { /* race ok */ }
        }
      }
      if (removed > 0) console.log(`[hls] cleaned ${dir} (${removed} stale files removed)`);
    } catch (e) {
      console.error(`[hls] cleanup error:`, e instanceof Error ? e.message : e);
    }
  }

  isReady(): boolean {
    return this._ready && fs.existsSync(path.join(this.hlsDir, "stream.m3u8"));
  }

  getError(): string | null { return this._error; }
}

// ─── MSE (fMP4 over WebSocket) ──────────────────────────────────────────────
// Low-latency alternative to HLS: ffmpeg outputs fragmented MP4 on stdout,
// the server caches the init segment (ftyp+moov) and broadcasts every
// subsequent moof+mdat fragment to all connected WebSocket clients.
// Re-encode is always on for MSE: predictable codec + short GOP = fast join.

const MSE_FRAG_DURATION_US = process.env["MSE_FRAG_DURATION_US"] ?? "200000"; // 200ms

class MseManager {
  private proc: ChildProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private _ready = false;
  private _error: string | null = null;

  // MP4 box accumulator
  private byteBuf = Buffer.alloc(0);
  // Init segment = ftyp + moov, cached for new subscribers
  private initSegment: Buffer | null = null;
  private codecString: string | null = null;
  // Buffer for the in-flight live fragment (moof, then mdat → flush together)
  private fragBuf: Buffer[] = [];
  // Last keyframe fragment (moof+mdat) — sent to new subscribers so they can
  // start decoding immediately instead of waiting for the next keyframe.
  private lastKeyframeFragment: Buffer | null = null;

  // HEVC warmup: suppress fragment delivery until the decoder has locked onto
  // its first IDR. lastHevcErrorMs=0 means "no HEVC errors seen" (H.264 camera)
  // → hevcClean() returns true immediately → warmup completes on first IDR fragment.
  private lastHevcErrorMs = 0;
  private hevcCleanSince = 0;  // timestamp when hevcClean() first became true
  private hevcWarmupDone = false;

  private subscribers = new Set<WebSocket>();
  // Tracks which subscribers have already received the init segment, so a
  // late-arriving moov box only goes out once per client.
  private subscriberInitSent = new WeakSet<WebSocket>();
  // Set true once stop() is called — prevents the close handler from
  // auto-restarting a stream that the user has switched away from.
  private stopping = false;

  constructor(private rtspUrl: string) {}

  start(): void {
    if (this.proc) {
      console.log(`[mse] start() ignored — ffmpeg already running (pid=${this.proc.pid})`);
      return;
    }
    this.stopping = false;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.spawn();
  }

  private spawn(): void {
    if (this.proc) {
      console.warn(`[mse] spawn() skipped — ffmpeg already running (pid=${this.proc.pid})`);
      return;
    }
    const args = [
      "-hide_banner", "-nostats",
      "-fflags", "nobuffer+flush_packets", "-flags", "low_delay",
      "-rtsp_transport", HLS_RTSP_TRANSPORT,
      // HEVC needs longer probe window; err_detect tells the decoder to keep
      // going on reference-frame errors instead of marking frames as corrupt.
      "-analyzeduration", "5000000",
      "-probesize", "5000000",
      "-err_detect", "ignore_err",
      "-i", this.rtspUrl,
      // Video re-encode: baseline H.264 (deterministic codec string for MSE)
      "-c:v", "libx264",
      "-preset", HLS_PRESET,
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-pix_fmt", "yuv420p",
      "-force_key_frames", `expr:gte(t,n_forced*${HLS_TIME})`,
      "-sc_threshold", "0",
      "-b:v", HLS_VIDEO_BITRATE,
      "-maxrate", HLS_VIDEO_BITRATE,
      "-bufsize", HLS_VIDEO_BITRATE,
      // Audio: AAC-LC
      "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "96k",
      // fMP4 output
      "-f", "mp4",
      // frag_keyframe: new fragment at each keyframe (and sub-keyframe via frag_duration)
      // default_base_moof: base offsets relative to moof — required for streaming
      // No empty_moov: real moov with codec info → parseCodecFromMoov works correctly
      // No separate_moof: audio+video interleaved in one moof+mdat → single SourceBuffer OK
      "-movflags", "frag_keyframe+default_base_moof",
      "-frag_duration", MSE_FRAG_DURATION_US,
      "pipe:1",
    ];

    const redacted = args.map((a) => a.replace(/rtsp:\/\/[^@]+@/, "rtsp://***@"));
    console.log(`[mse] ffmpeg ${redacted.join(" ")}`);
    console.log(`[mse] mode: re-encode (codec=libx264 baseline, preset=${HLS_PRESET}, bitrate=${HLS_VIDEO_BITRATE}, gop=${HLS_TIME}s, frag=${MSE_FRAG_DURATION_US}µs)`);
    console.log(`[mse] latency strategy: low (fMP4 over WebSocket, ~${(parseInt(MSE_FRAG_DURATION_US, 10) / 1000).toFixed(0)}ms fragments)`);

    this.proc = spawn("ffmpeg", args);
    const procPid = this.proc.pid;
    console.log(`[mse] ffmpeg started (pid=${procPid})`);

    this.proc.stdout?.on("data", (chunk: Buffer) => this.consume(chunk));
    this.proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      // Track HEVC decoder sync errors — used by hevcClean() to gate fragment delivery
      if (/Could not find ref|frame RPS|undecodable NALU|First slice in a frame/i.test(line)) {
        this.lastHevcErrorMs = Date.now();
      }
      if (/error|failed|invalid/i.test(line) && !/size=|time=/i.test(line)) {
        console.error("[mse]", line);
        this._error = line;
      }
    });
    this.proc.on("close", (code) => {
      console.log(`[mse] ffmpeg exit ${code} (pid=${procPid})`);
      this.proc = null;
      this._ready = false;
      this.byteBuf = Buffer.alloc(0);
      this.fragBuf = [];
      // Auto-restart only if not deliberately stopped AND clients are waiting
      if (!this.stopping && code !== 0 && code !== null && this.subscribers.size > 0) {
        this._error = `ffmpeg exited (${code})`;
        console.log(`[mse] scheduling restart in 8s (subscribers=${this.subscribers.size})`);
        this.restartTimer = setTimeout(() => this.spawn(), 8000);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const proc = this.proc;
    this.proc = null;
    this._ready = false;
    if (proc) {
      const pid = proc.pid;
      console.log(`[mse] stopping ffmpeg (pid=${pid})`);
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => { if (!done) { done = true; resolve(); } };
        proc.once("exit", finish);
        proc.once("close", finish);
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => {
          if (!done) {
            console.warn(`[mse] SIGTERM timed out (pid=${pid}), sending SIGKILL`);
            try { proc.kill("SIGKILL"); } catch { /* ignore */ }
          }
        }, 2000);
        setTimeout(finish, 5000);
      });
      console.log(`[mse] ffmpeg stopped (pid=${pid})`);
    }
    this.byteBuf = Buffer.alloc(0);
    this.initSegment = null;
    this.codecString = null;
    this.fragBuf = [];
    this.lastKeyframeFragment = null;
    this.hevcWarmupDone = false;
    this.lastHevcErrorMs = 0;
    this.hevcCleanSince = 0;
    const n = this.subscribers.size;
    for (const ws of this.subscribers) {
      try { ws.close(1000, "stream stopped"); } catch { /* ignore */ }
    }
    this.subscribers.clear();
    this.subscriberInitSent = new WeakSet();
    if (n > 0) console.log(`[mse] disconnected ${n} subscriber(s) on stop`);
  }

  isReady(): boolean { return this._ready && this.initSegment !== null; }
  getError(): string | null { return this._error; }
  getCodec(): string | null { return this.codecString; }
  subscriberCount(): number { return this.subscribers.size; }

  // True once the HEVC decoder has been error-free long enough for the H.264
  // encoder to have flushed its dirty reference frames via a forced IDR.
  // lastHevcErrorMs=0 (no errors ever) → always true (H.264 camera, no warmup).
  private hevcClean(): boolean {
    if (this.lastHevcErrorMs === 0) return true;
    const gopMs = parseInt(HLS_TIME, 10) * 1000 + 500; // 1 GOP + 500ms buffer
    return Date.now() - this.lastHevcErrorMs > gopMs;
  }

  // Returns true if the fMP4 fragment (moof+mdat) starts with an H.264 IDR
  // (keyframe). Parses traf→tfhd.default_sample_flags and trun.first_sample_flags.
  // Bit 0x01000000 = sample_is_non_sync_sample; if unset → sync/keyframe.
  // Falls back to false (conservative) on any parse error.
  private isKeyframeFragment(fragment: Buffer): boolean {
    try {
      if (fragment.length < 8) return false;
      const moofSize = fragment.readUInt32BE(0);
      if (fragment.subarray(4, 8).toString("ascii") !== "moof") return false;
      const moof = fragment.subarray(0, Math.min(moofSize, fragment.length));

      // Walk top-level boxes inside moof to find traf
      let off = 8;
      while (off + 8 <= moof.length) {
        const size = moof.readUInt32BE(off);
        if (size < 8) break;
        if (moof.subarray(off + 4, off + 8).toString("ascii") === "traf") {
          const trafEnd = off + size;
          let tfhdDefaultSampleFlags: number | null = null;
          let trunFirstSampleFlags: number | null = null;

          let toff = off + 8;
          while (toff + 8 <= trafEnd) {
            const ts = moof.readUInt32BE(toff);
            if (ts < 8) break;
            const tt = moof.subarray(toff + 4, toff + 8).toString("ascii");

            if (tt === "tfhd" && toff + 16 <= moof.length) {
              // FullBox: size(4)+type(4)+version(1)+flags(3). Flags are at toff+9..11, NOT toff+8 (version).
              const fl = ((moof[toff + 9]! << 16) | (moof[toff + 10]! << 8) | moof[toff + 11]!) >>> 0;
              if (fl & 0x000020) { // default_sample_flags present
                let foff = toff + 16;
                if (fl & 0x000001) foff += 8; // base_data_offset
                if (fl & 0x000002) foff += 4; // sample_description_index
                if (fl & 0x000008) foff += 4; // default_sample_duration
                if (fl & 0x000010) foff += 4; // default_sample_size
                if (foff + 4 <= moof.length) tfhdDefaultSampleFlags = moof.readUInt32BE(foff);
              }
            }

            if (tt === "trun" && toff + 16 <= moof.length) {
              const fl = ((moof[toff + 9]! << 16) | (moof[toff + 10]! << 8) | moof[toff + 11]!) >>> 0;
              if (fl & 0x000004) { // first_sample_flags present
                let foff = toff + 16; // after version+flags+sample_count
                if (fl & 0x000001) foff += 4; // data_offset
                if (foff + 4 <= moof.length) trunFirstSampleFlags = moof.readUInt32BE(foff);
              }
            }

            toff += ts;
          }

          // trun.first_sample_flags overrides tfhd.default_sample_flags for the first sample
          const effective = trunFirstSampleFlags ?? tfhdDefaultSampleFlags ?? 0x01000000;
          return (effective & 0x01000000) === 0; // non-sync bit unset → keyframe
        }
        off += size;
      }
    } catch { /* ignore parse errors — treated as non-keyframe */ }
    return false;
  }

  // ── MP4 box scanner ────────────────────────────────────────────────────────
  // Reads top-level ISO-BMFF boxes from the ffmpeg stdout stream.
  // Box format: 4 bytes size (BE) + 4 bytes type (ASCII) + payload.
  // (We don't handle 64-bit largesize; fMP4 fragments don't use it.)
  private consume(chunk: Buffer): void {
    this.byteBuf = Buffer.concat([this.byteBuf, chunk]);
    while (this.byteBuf.length >= 8) {
      const size = this.byteBuf.readUInt32BE(0);
      if (size < 8 || size > 64 * 1024 * 1024) {
        console.error(`[mse] invalid box size ${size}, resetting buffer`);
        this.byteBuf = Buffer.alloc(0);
        return;
      }
      if (this.byteBuf.length < size) return; // need more bytes
      const type = this.byteBuf.subarray(4, 8).toString("ascii");
      const box = this.byteBuf.subarray(0, size);
      this.byteBuf = this.byteBuf.subarray(size);
      this.handleBox(type, box);
    }
  }

  private handleBox(type: string, box: Buffer): void {
    if (type === "ftyp") {
      // Start of init segment
      this.initSegment = Buffer.from(box);
      return;
    }
    if (type === "moov") {
      // End of init segment → cache, parse codec, mark ready
      this.initSegment = this.initSegment
        ? Buffer.concat([this.initSegment, box])
        : Buffer.from(box);
      this.codecString = this.parseCodecFromMoov(box) ?? 'avc1.42E01F,mp4a.40.2';
      this._ready = true;
      console.log(`[mse] init segment ready (${this.initSegment.length}B, codecs=${this.codecString})`);
      // Defer pushing to subscribers until HEVC warmup completes (flushFragment
      // handles the push once hevcClean() returns true). For H.264 cameras the
      // warmup flag is already set on the first fragment, so this is a no-op.
      if (this.hevcWarmupDone) {
        let pushed = 0;
        for (const ws of this.subscribers) {
          if (!this.subscriberInitSent.has(ws) && this.sendInitTo(ws)) pushed++;
        }
        if (pushed > 0) console.log(`[mse] pushed init to ${pushed} waiting subscriber(s)`);
      } else {
        console.log(`[mse] init ready — deferring push until HEVC warmup complete`);
      }
      return;
    }
    if (type === "moof") {
      // Start of a live fragment. Flush any previously-collected fragment
      // (defensive — under normal ffmpeg output moof+mdat pair cleanly).
      if (this.fragBuf.length > 0) this.flushFragment();
      this.fragBuf.push(Buffer.from(box));
      return;
    }
    if (type === "mdat") {
      this.fragBuf.push(Buffer.from(box));
      this.flushFragment();
      return;
    }
    if (type === "styp" || type === "sidx" || type === "free") {
      // Segment-level housekeeping boxes — drop; not needed for MSE streaming
      // (including them in fragBuf would cause a spurious partial-flush on the next moof)
      return;
    }
    // Unknown / ignored boxes — drop silently
  }

  private flushFragment(): void {
    if (this.fragBuf.length === 0) return;
    const fragment = Buffer.concat(this.fragBuf);
    this.fragBuf = [];

    if (!this.hevcWarmupDone) {
      if (!this.hevcClean()) {
        this.hevcCleanSince = 0;
        return; // HEVC still syncing — discard fragment
      }
      if (this.hevcCleanSince === 0) this.hevcCleanSince = Date.now();

      const isKf = this.isKeyframeFragment(fragment);
      // Safety fallback: if hevcClean for >5 s but no IDR detected (parser issue),
      // force-start anyway so the stream doesn't stall indefinitely.
      const timedOut = Date.now() - this.hevcCleanSince > 5000;
      if (!isKf && !timedOut) return; // wait for first clean IDR fragment

      // First keyframe fragment after HEVC sync — go live
      this.hevcWarmupDone = true;
      const lag = this.lastHevcErrorMs > 0
        ? `${((Date.now() - this.lastHevcErrorMs) / 1000).toFixed(1)}s after last HEVC error`
        : `immediately (no HEVC errors)`;
      const reason = isKf ? "first clean IDR fragment" : "5 s timeout (IDR detection fallback)";
      console.log(`[mse] HEVC warmup complete (${lag}, ${reason}) — sending init to subscribers`);
      // sendInitTo sends init+moov only (lastKeyframeFragment is null here).
      // The IDR fragment follows via the loop below — no double-send.
      let pushed = 0;
      for (const ws of this.subscribers) {
        if (!this.subscriberInitSent.has(ws) && this.sendInitTo(ws)) pushed++;
      }
      if (pushed > 0) console.log(`[mse] pushed init to ${pushed} subscriber(s)`);
      this.lastKeyframeFragment = fragment; // set after sendInitTo to avoid double-send
      // Fall through — send the IDR fragment to all subscribers below
    } else if (this.isKeyframeFragment(fragment)) {
      this.lastKeyframeFragment = fragment; // keep fresh for late subscribers
    } else if (!this.lastKeyframeFragment) {
      this.lastKeyframeFragment = fragment;
    }

    for (const ws of this.subscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(fragment); } catch { /* drop on socket error */ }
      }
    }
  }

  // Recursively walk moov → trak → mdia → minf → stbl → stsd → avc1 → avcC
  // to read the H.264 profile/compat/level bytes for the codec string.
  private parseCodecFromMoov(moov: Buffer): string | null {
    const findBox = (buf: Buffer, name: string, start = 8): Buffer | null => {
      let off = start;
      while (off + 8 <= buf.length) {
        const size = buf.readUInt32BE(off);
        if (size < 8 || off + size > buf.length) return null;
        const type = buf.subarray(off + 4, off + 8).toString("ascii");
        if (type === name) return buf.subarray(off, off + size);
        off += size;
      }
      return null;
    };
    try {
      const trak = findBox(moov, "trak");
      if (!trak) return null;
      const mdia = findBox(trak, "mdia");
      if (!mdia) return null;
      const minf = findBox(mdia, "minf");
      if (!minf) return null;
      const stbl = findBox(minf, "stbl");
      if (!stbl) return null;
      const stsd = findBox(stbl, "stsd");
      if (!stsd) return null;
      // stsd: 4 size + 4 type + 4 version/flags + 4 entry_count + entries…
      // First entry header: 4 size + 4 type ('avc1') + 6 reserved + 2 dref_index + … 78 bytes header
      const avc1 = findBox(stsd, "avc1", 16);
      if (!avc1) return null;
      const avcC = findBox(avc1, "avcC", 8 + 78);
      if (!avcC || avcC.length < 12) return null;
      // avcC payload: configurationVersion(1) profile(1) compat(1) level(1)
      const profile = avcC[8 + 1]!;
      const compat = avcC[8 + 2]!;
      const level = avcC[8 + 3]!;
      const hex = (n: number): string => n.toString(16).padStart(2, "0").toUpperCase();
      return `avc1.${hex(profile)}${hex(compat)}${hex(level)},mp4a.40.2`;
    } catch {
      return null;
    }
  }

  // ── Subscriber lifecycle ────────────────────────────────────────────────────
  addSubscriber(ws: WebSocket): void {
    this.subscribers.add(ws);
    ws.on("close", () => {
      this.subscribers.delete(ws);
      console.log(`[mse] subscriber disconnected (remaining=${this.subscribers.size})`);
    });
    ws.on("error", (e) => {
      this.subscribers.delete(ws);
      console.log(`[mse] subscriber error: ${e.message} (remaining=${this.subscribers.size})`);
    });

    if (this.initSegment && this.codecString && this.hevcWarmupDone) {
      this.sendInitTo(ws);
    } else {
      try { ws.send(JSON.stringify({ type: "wait" })); } catch { /* ignore */ }
      console.log(`[mse] subscriber waiting for init (subscribers=${this.subscribers.size})`);
    }
  }

  // Sends the init handshake (codec JSON + init segment + optional keyframe
  // fragment) to a single subscriber. Returns true on success.
  // Marks the subscriber via WeakSet so it doesn't receive duplicates.
  private sendInitTo(ws: WebSocket): boolean {
    if (!this.initSegment || !this.codecString) return false;
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (this.subscriberInitSent.has(ws)) return false;
    try {
      ws.send(JSON.stringify({ type: "init", codecs: this.codecString }));
      ws.send(this.initSegment);
      if (this.lastKeyframeFragment) ws.send(this.lastKeyframeFragment);
      this.subscriberInitSent.add(ws);
      return true;
    } catch {
      return false;
    }
  }
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
  let mse: MseManager | null = null;
  let ringtones: Ringtone[] = [];
  let chimeDevices: ChimeDevice[] = [];

  // ── Video mode ────────────────────────────────────────────────────────────────
  // hls = default, stable, ~10-12s latency, low CPU
  // mse = fMP4 over WebSocket, ~1-2s latency, re-encodes (~1 core CPU)
  type VideoMode = "hls" | "mse";
  const VALID_MODES: ReadonlySet<VideoMode> = new Set(["hls", "mse"]);
  const envMode = (process.env["VIDEO_MODE"] ?? "hls").toLowerCase() as VideoMode;
  let videoMode: VideoMode = VALID_MODES.has(envMode) ? envMode : "hls";
  console.log(`[server] VIDEO_MODE=${videoMode}`);

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

  const buildRtspUrl = (): string | null => {
    const channels = cameraDetails?.channels ?? [];
    const channel = channels.find((c) => c.isRtspEnabled) ?? channels[0];
    if (!channel?.rtspAlias || !protectHost) return null;
    const user = encodeURIComponent(process.env["PROTECT_USERNAME"] ?? "");
    const pass = encodeURIComponent(process.env["PROTECT_PASSWORD"] ?? "");
    const auth = user && pass ? `${user}:${pass}@` : "";
    console.log(`[stream] RTSP channel: ${channel.name} (${channel.width}x${channel.height})`);
    return `rtsp://${auth}${protectHost}:7447/${channel.rtspAlias}`;
  };

  const startVideoStream = (): void => {
    if (!activeCameraId) return;
    if (hls || mse) {
      console.warn(`[stream] startVideoStream() called while pipeline already active — skipping (hls=${!!hls} mse=${!!mse})`);
      return;
    }
    const rtspUrl = buildRtspUrl();
    if (!rtspUrl) {
      console.warn("[stream] no RTSP channel or host configured");
      return;
    }
    if (videoMode === "mse") {
      console.log(`[stream] active mode: MSE (low latency, ~1-2s)`);
      mse = new MseManager(rtspUrl);
      mse.start();
    } else {
      console.log(`[stream] active mode: HLS (stable, ~10s)`);
      hls = new HlsManager(rtspUrl, HLS_DIR);
      hls.start();
    }
  };

  const stopVideoStream = async (): Promise<void> => {
    const tasks: Promise<void>[] = [];
    if (hls) { console.log(`[stream] stopping HLS pipeline`); tasks.push(hls.stop()); }
    if (mse) { console.log(`[stream] stopping MSE pipeline`); tasks.push(mse.stop()); }
    await Promise.all(tasks);
    hls = null;
    mse = null;
    console.log(`[stream] all pipelines stopped`);
  };

  // Serialize concurrent mode-switch requests via a promise chain. Each new
  // call .then()s onto the previous one, guaranteeing no two switch handlers
  // run interleaved — eliminates the "two parallel ffmpegs in same temp dir"
  // race that a flag-based lock had with its release window.
  let switchQueue: Promise<void> = Promise.resolve();

  const switchVideoMode = (target: VideoMode): Promise<void> => {
    switchQueue = switchQueue.then(async () => {
      if (target === videoMode) {
        console.log(`[stream] switch noop — already in mode ${target}`);
        return;
      }
      const from = videoMode;
      console.log(`[stream] switching mode: ${from} → ${target}`);
      await stopVideoStream();
      videoMode = target;
      startVideoStream();
      console.log(`[stream] switch complete: ${from} → ${videoMode}`);
    }).catch((e) => {
      console.error(`[stream] switch error:`, e instanceof Error ? e.message : e);
    });
    return switchQueue;
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
    const cameraIdAtActivation = activeCameraId;
    void loadCameraDetails().then(() => {
      if (activeCameraId !== cameraIdAtActivation) {
        console.log(`[stream] activateCamera() snapshot mismatch — camera changed while loading details, skipping start`);
        return;
      }
      startVideoStream();
    });
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

    // HTML pages — allow embedding via Home Assistant Ingress, panel_iframe,
    // Lovelace iframe cards and local dev (http/https). Exotic schemes
    // (data:, javascript:, file:) are disallowed.
    // Override via FRAME_ANCESTORS env var if a stricter / different policy
    // is required (e.g. "'self' https://homeassistant.local:8123").
    if (method === "GET" && (url === "/" || url === "/index.html" || url === "/push-to-talk.html")) {
      const ingressPath = (req.headers["x-ingress-path"] as string | undefined) ?? "";
      if (ingressPath) console.log(`[server] Ingress mode — base path: ${ingressPath}`);
      const frameAncestors = (process.env["FRAME_ANCESTORS"] ?? "'self' http: https:").trim();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `frame-ancestors ${frameAncestors}`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(fs.readFileSync(HTML_PATH));
      return;
    }

    if (method === "GET" && url === "/config.json") {
      const ingressPath = (req.headers["x-ingress-path"] as string | undefined) ?? "";
      setCorsHeaders(res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ timesliceMs, ingressPath }));
      return;
    }

    // HLS playlist
    if (method === "GET" && url === "/hls/stream.m3u8") {
      const m3u8 = path.join(HLS_DIR, "stream.m3u8");
      if (!fs.existsSync(m3u8)) {
        res.writeHead(503, { "Retry-After": "3" }); res.end("Stream not ready");
        return;
      }
      const hlsHeaders: Record<string, string> = {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store",
      };
      if (CORS_ALLOW_ORIGIN) hlsHeaders["Access-Control-Allow-Origin"] = CORS_ALLOW_ORIGIN;
      res.writeHead(200, hlsHeaders);
      res.end(fs.readFileSync(m3u8));
      return;
    }

    // HLS segments — regex prevents path traversal; handles both TS and fMP4 (m4s)
    const segMatch = url.match(/^\/hls\/(seg\d{3}\.(ts|m4s))$/);
    if (method === "GET" && segMatch?.[1]) {
      const segFile = path.join(HLS_DIR, segMatch[1]);
      if (!fs.existsSync(segFile)) { res.writeHead(404); res.end(); return; }
      const segHeaders: Record<string, string> = {
        "Content-Type": segMatch[2] === "m4s" ? "video/iso.segment" : "video/mp2t",
        "Cache-Control": "no-cache",
      };
      if (CORS_ALLOW_ORIGIN) segHeaders["Access-Control-Allow-Origin"] = CORS_ALLOW_ORIGIN;
      res.writeHead(200, segHeaders);
      fs.createReadStream(segFile).pipe(res);
      return;
    }

    // fMP4 init segment (EXT-X-MAP) — only present when hls_reencode is on
    if (method === "GET" && url === "/hls/init.mp4") {
      const initFile = path.join(HLS_DIR, "init.mp4");
      if (!fs.existsSync(initFile)) { res.writeHead(404); res.end(); return; }
      const initHeaders: Record<string, string> = {
        "Content-Type": "video/mp4",
        "Cache-Control": "no-cache",
      };
      if (CORS_ALLOW_ORIGIN) initHeaders["Access-Control-Allow-Origin"] = CORS_ALLOW_ORIGIN;
      res.writeHead(200, initHeaders);
      fs.createReadStream(initFile).pipe(res);
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

      // Stop both pipelines (only one is active at a time, but be defensive
      // in case a previous switch left a stale handle) before switching cam.
      await stopVideoStream();
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
        stream: {
          mode: videoMode,
          hlsReady: hls?.isReady() ?? false,
          hlsError: hls?.getError() ?? null,
          mseReady: mse?.isReady() ?? false,
          mseError: mse?.getError() ?? null,
          mseCodec: mse?.getCodec() ?? null,
        },
        activeCameraId,
      });
      return;
    }

    if (url === "/api/video-mode" && method === "GET") {
      json(res, { mode: videoMode, available: ["hls", "mse"] });
      return;
    }

    if (url === "/api/video-mode" && method === "POST") {
      const body = await parseBody(req);
      let target = String(body["mode"] ?? "").toLowerCase();
      if (!VALID_MODES.has(target as VideoMode)) {
        json(res, { error: `invalid mode (expected hls|mse), got: ${target}` }, 400);
        return;
      }
      // MSE is disabled — silently redirect to HLS
      if (target === "mse") {
        console.log("[stream] POST /api/video-mode mse → rejected, MSE disabled, using hls");
        target = "hls";
      }
      await switchVideoMode(target as VideoMode);
      json(res, { ok: true, mode: videoMode });
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
        const audioHeaders: Record<string, string> = {
          "Content-Type": ct,
          "Content-Length": String(data.length),
          "Cache-Control": "public, max-age=3600",
        };
        if (CORS_ALLOW_ORIGIN) audioHeaders["Access-Control-Allow-Origin"] = CORS_ALLOW_ORIGIN;
        res.writeHead(200, audioHeaders);
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
      // Debug endpoint — only enabled when LOG_LEVEL=debug to avoid leaking
      // device IPs / MAC addresses through the public API surface.
      if ((process.env["LOG_LEVEL"] ?? "").toLowerCase() !== "debug") {
        res.writeHead(404); res.end();
        return;
      }
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

  // ── WebSocket: multiplex /audio (talkback) and /mse-stream (live video) ─────
  const wssTalkback = new WebSocketServer({ noServer: true });
  const wssMse = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url ?? "";
    if (reqUrl === "/audio") {
      wssTalkback.handleUpgrade(req, socket, head, (ws) => {
        wssTalkback.emit("connection", ws, req);
      });
    } else if (reqUrl === "/mse-stream") {
      wssMse.handleUpgrade(req, socket, head, (ws) => {
        wssMse.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  // MSE WebSocket: clients subscribe to live fMP4 fragments
  wssMse.on("connection", (ws) => {
    if (videoMode !== "mse" || !mse) {
      console.log(`[mse] rejecting client — mode=${videoMode}`);
      ws.close(1011, `mode is ${videoMode}, not mse`);
      return;
    }
    console.log(`[mse] client connected (total=${mse.subscriberCount() + 1})`);
    mse.addSubscriber(ws);
  });

  let sessionActive = false;
  const wss = wssTalkback;

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

  // Cleanup on exit — fire-and-forget but await briefly so ffmpeg gets SIGTERM
  let exiting = false;
  const cleanup = (signal: string): void => {
    if (exiting) return;
    exiting = true;
    console.log(`[server] received ${signal}, shutting down…`);
    void stopVideoStream()
      .catch((e) => console.error("[server] cleanup error:", e))
      .finally(() => process.exit(0));
    // Hard exit after 6s if cleanup hangs
    setTimeout(() => process.exit(0), 6000).unref();
  };
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));

  httpServer.listen(serverPort, () => {
    console.log(`[server] ${proto}://localhost:${serverPort}`);
  });
}
