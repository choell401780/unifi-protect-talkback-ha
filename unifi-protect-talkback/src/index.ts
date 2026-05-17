import "dotenv/config";
import { createClient, login, getCameras, probeEndpoints, inspectCameraFields } from "./protect-client.js";
import { openTalkback } from "./talkback.js";
import { startServer } from "./server.js";

const host = process.env["PROTECT_HOST"] ?? "";
const port = parseInt(process.env["PROTECT_PORT"] ?? "443", 10);
const username = process.env["PROTECT_USERNAME"] ?? "";
const password = process.env["PROTECT_PASSWORD"] ?? "";
const cameraId = process.env["PROTECT_CAMERA_ID"] ?? "";

if (!host || !username || !password) {
  console.error("Missing env vars: PROTECT_HOST, PROTECT_USERNAME, PROTECT_PASSWORD");
  process.exit(1);
}

try {
  const client = createClient(host, port);
  const session = await login(client, username, password);

  if (process.env["SERVER"] === "1") {
    if (!cameraId) { console.error("PROTECT_CAMERA_ID required for server mode"); process.exit(1); }
    const serverPort = parseInt(process.env["SERVER_PORT"] ?? "8080", 10);
    startServer(cameraId, session, client, serverPort);
  } else if (process.env["DIAGNOSE"] === "1" && cameraId) {
    await probeEndpoints(client, session, cameraId);
    await inspectCameraFields(client, session, cameraId);
  } else if (cameraId) {
    await openTalkback(host, port, cameraId, session, client, 5000);
  } else {
    const cameras = await getCameras(client, session);
    console.log("\nCameras (set PROTECT_CAMERA_ID to test talkback):");
    for (const cam of cameras) {
      console.log(`  [${cam.type}] ${cam.name}  id: ${cam.id}  state: ${cam.state}`);
    }
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Error:", msg);
  process.exit(1);
}
