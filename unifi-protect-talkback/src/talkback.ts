import WebSocket from "ws";
import type { AxiosInstance } from "axios";
import { getTalkbackWsUrl } from "./protect-client.js";
import type { ProtectSession } from "./protect-client.js";
import { streamAudio, streamAacFile, streamAacFileUdp } from "./audio.js";
import { runFfmpegRtp } from "./ffmpeg.js";

export async function openTalkback(
  host: string,
  port: number,
  cameraId: string,
  session: ProtectSession,
  client: AxiosInstance,
  durationMs = 5000
): Promise<void> {
  const wsUrl = await getTalkbackWsUrl(client, session, cameraId);
  const mode = process.env["AUDIO_TEST_MODE"] ?? "aac-file";

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      rejectUnauthorized: false,
      headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
    });

    const send = (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    };

    ws.on("open", async () => {
      console.log(`[talkback] connected — mode=${mode}`);

      try {
        if (mode === "rtp-opus") {
          const rtpHost = process.env["TALKBACK_RTP_HOST"] ?? "";
          if (!rtpHost) throw new Error("TALKBACK_RTP_HOST is required for rtp-opus mode");
          const rtpPort = parseInt(process.env["TALKBACK_RTP_PORT"] ?? "7004", 10);
          await runFfmpegRtp(rtpHost, rtpPort);
        } else if (mode === "udp-aac") {
          const filePath = process.env["AUDIO_TEST_FILE"] ?? "samples/test-tone-22050.aac";
          const udpHost = process.env["TALKBACK_UDP_HOST"] ?? host;
          const udpPort = parseInt(process.env["TALKBACK_UDP_PORT"] ?? "7004", 10);
          await streamAacFileUdp(filePath, udpHost, udpPort);
        } else if (mode === "aac-file") {
          const filePath = process.env["AUDIO_TEST_FILE"] ?? "samples/test-tone-22050.aac";
          await streamAacFile(filePath, send);
        } else {
          await streamAudio(send, durationMs);
        }
        ws.close(1000, "done");
      } catch (err) {
        ws.close(1011, "stream error");
        reject(err);
      }
    });

    ws.on("message", (data: Buffer) => {
      console.log("[talkback] message received:", data.length, "bytes");
    });

    ws.on("close", (code, reason) => {
      console.log(`[talkback] closed (code: ${code}, reason: ${reason.toString() || "–"})`);
      resolve();
    });

    ws.on("error", (err: Error) => {
      console.error("[talkback] error:", err.message);
      reject(err);
    });
  });
}
