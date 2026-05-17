import { spawn } from "node:child_process";

export async function runFfmpegRtp(rtpHost: string, rtpPort: number): Promise<void> {
  const args = [
    "-re", "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
    "-acodec", "libopus", "-ar", "24000", "-ac", "1",
    "-f", "rtp", `rtp://${rtpHost}:${rtpPort}`,
  ];

  console.log(`[ffmpeg] ffmpeg ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

    const stderrBuf: string[] = [];
    proc.stderr?.on("data", (d: Buffer) => stderrBuf.push(d.toString()));

    proc.on("error", (err) => reject(new Error(`ffmpeg spawn: ${err.message}`)));

    proc.on("close", (code) => {
      // last meaningful ffmpeg line (skip blank/progress lines)
      const tail = stderrBuf
        .join("")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(-2)
        .join(" | ");
      console.log(`[ffmpeg] exit=${code} | ${tail}`);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}
