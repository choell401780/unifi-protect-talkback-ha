import { readFile } from "node:fs/promises";
import dgram from "node:dgram";

// PCM 16-bit, 16 kHz, mono
export const SAMPLE_RATE = 16000;
const CHUNK_MS = 20;
const SAMPLES_PER_CHUNK = (SAMPLE_RATE * CHUNK_MS) / 1000; // 320 samples
const BYTES_PER_CHUNK = SAMPLES_PER_CHUNK * 2;              // 640 bytes (16-bit LE)

function silenceChunk(): Buffer {
  return Buffer.alloc(BYTES_PER_CHUNK, 0);
}

function toneChunk(freqHz: number, sampleOffset: number): Buffer {
  const buf = Buffer.alloc(BYTES_PER_CHUNK);
  for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
    const t = (sampleOffset + i) / SAMPLE_RATE;
    const sample = Math.round(Math.sin(2 * Math.PI * freqHz * t) * 32767 * 0.5);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

export type AudioMode = "pcm-tone" | "aac-file";

export function streamAudio(
  send: (chunk: Buffer) => void,
  durationMs: number,
  freqHz = 440
): Promise<void> {
  return new Promise((resolve) => {
    let sent = 0;
    let totalBytes = 0;
    let sampleOffset = 0;

    const interval = setInterval(() => {
      const chunk = toneChunk(freqHz, sampleOffset);
      send(chunk);
      sent++;
      totalBytes += chunk.length;
      sampleOffset += SAMPLES_PER_CHUNK;
    }, CHUNK_MS);

    setTimeout(() => {
      clearInterval(interval);
      console.log(
        `[audio] mode=pcm-tone freq=${freqHz}Hz sampleRate=${SAMPLE_RATE}Hz` +
        ` chunks=${sent} bytes=${totalBytes} duration=${sent * CHUNK_MS}ms`
      );
      resolve();
    }, durationMs);
  });
}

// AAC-ADTS sample rate lookup table
const ADTS_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AAC_SAMPLES_PER_FRAME = 1024;

function parseAdtsFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let i = 0;
  while (i + 7 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1]! & 0xf0) !== 0xf0) { i++; continue; }
    const frameLen =
      ((buf[i + 3]! & 0x03) << 11) |
      (buf[i + 4]! << 3)           |
      ((buf[i + 5]! >> 5) & 0x07);
    if (frameLen < 7 || i + frameLen > buf.length) break;
    frames.push(buf.subarray(i, i + frameLen));
    i += frameLen;
  }
  return frames;
}

function adtsSampleRate(frame: Buffer): number {
  const idx = (frame[2]! >> 2) & 0x0f;
  return ADTS_SAMPLE_RATES[idx] ?? 16000;
}

export async function streamAacFileUdp(
  filePath: string,
  udpHost: string,
  udpPort: number
): Promise<void> {
  const data = await readFile(filePath);
  const frames = parseAdtsFrames(data);
  if (frames.length === 0) throw new Error(`No ADTS frames in ${filePath}`);

  const sampleRate = adtsSampleRate(frames[0]!);
  const frameIntervalMs = (AAC_SAMPLES_PER_FRAME / sampleRate) * 1000; // ~46.4ms @ 22050Hz

  const socket = dgram.createSocket("udp4");
  let sent = 0;
  let totalBytes = 0;

  console.log(`[audio] udp-aac → ${udpHost}:${udpPort} | ${frames.length} frames | sampleRate=${sampleRate}Hz | interval=${frameIntervalMs.toFixed(1)}ms`);

  return new Promise((resolve, reject) => {
    socket.on("error", (err) => { socket.close(); reject(err); });

    const interval = setInterval(() => {
      if (sent >= frames.length) {
        clearInterval(interval);
        socket.close();
        console.log(`[audio] mode=udp-aac frames=${sent} bytes=${totalBytes} duration=${Math.round(sent * frameIntervalMs)}ms`);
        resolve();
        return;
      }
      const frame = frames[sent]!;
      socket.send(frame, udpPort, udpHost, (err) => {
        if (err) console.error("[audio] UDP send error:", err.message);
      });
      totalBytes += frame.length;
      sent++;
    }, frameIntervalMs);
  });
}

export async function streamAacFile(
  filePath: string,
  send: (chunk: Buffer) => void
): Promise<void> {
  const data = await readFile(filePath);
  const frames = parseAdtsFrames(data);
  if (frames.length === 0) throw new Error(`No ADTS frames in ${filePath}`);

  const sampleRate = adtsSampleRate(frames[0]!);
  const frameIntervalMs = (AAC_SAMPLES_PER_FRAME / sampleRate) * 1000;
  const totalBytes = frames.reduce((s, f) => s + f.length, 0);
  const avgFrameSize = Math.round(totalBytes / frames.length);
  const durationMs = Math.round(frames.length * frameIntervalMs);
  const bitrateKbps = Math.round((totalBytes * 8) / (durationMs / 1000) / 1000);
  const sendMode = process.env["AUDIO_SEND_MODE"] ?? "frame";

  console.log(
    `[audio] sampleRate=${sampleRate}Hz bitrate≈${bitrateKbps}kbps` +
    ` frames=${frames.length} avgFrameSize=${avgFrameSize}B duration=${durationMs}ms mode=${sendMode}`
  );

  if (sendMode === "stream") {
    // Burst: send all frames immediately, let NVR buffer
    for (const frame of frames) send(frame);
    console.log(`[audio] stream: burst ${frames.length} frames (${totalBytes} bytes)`);
    return;
  }

  // frame mode: drift-corrected timer (avoids accumulated error of setInterval with float interval)
  return new Promise((resolve) => {
    const start = performance.now();
    let sent = 0;

    const tick = () => {
      const elapsed = performance.now() - start;
      const target = Math.floor(elapsed / frameIntervalMs);

      while (sent <= target && sent < frames.length) {
        send(frames[sent]!);
        sent++;
      }

      if (sent >= frames.length) {
        const actual = Math.round(performance.now() - start);
        console.log(`[audio] frame: sent=${sent} bytes=${totalBytes} actual=${actual}ms`);
        resolve();
        return;
      }

      const nextMs = (sent * frameIntervalMs) - (performance.now() - start);
      setTimeout(tick, Math.max(0, nextMs));
    };

    tick();
  });
}
