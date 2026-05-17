import "dotenv/config";
import { createClient, login, getCameras, probeEndpoints, inspectCameraFields } from "./protect-client.js";
import { openTalkback } from "./talkback.js";
import { startServer } from "./server.js";

const host = process.env["PROTECT_HOST"] ?? "";
const port = parseInt(process.env["PROTECT_PORT"] ?? "443", 10);
const username = process.env["PROTECT_USERNAME"] ?? "";
const password = process.env["PROTECT_PASSWORD"] ?? "";
const sslVerify = process.env["SSL_VERIFY"] === "1";

// Discovery options — all optional
const cameraId = process.env["PROTECT_CAMERA_ID"] ?? "";
const doorbellName = process.env["DOORBELL_NAME"] ?? "";
const doorbellMac = process.env["DOORBELL_MAC"] ?? "";

if (!host || !username || !password) {
  console.error("Missing env vars: PROTECT_HOST, PROTECT_USERNAME, PROTECT_PASSWORD");
  process.exit(1);
}

try {
  const client = createClient(host, port, sslVerify);
  const session = await login(client, username, password);

  if (process.env["SERVER"] === "1") {
    const serverPort = parseInt(process.env["SERVER_PORT"] ?? "8080", 10);
    startServer(session, client, serverPort, { cameraId, doorbellName, doorbellMac });
  } else if (process.env["DIAGNOSE"] === "1" && cameraId) {
    await probeEndpoints(client, session, cameraId);
    await inspectCameraFields(client, session, cameraId);
  } else if (cameraId) {
    await openTalkback(host, port, cameraId, session, client, 5000);
  } else {
    const cameras = await getCameras(client, session);
    console.log("\nCameras:");
    for (const cam of cameras) {
      console.log(`  [${cam.type}] ${cam.name}  id: ${cam.id}  mac: ${cam.mac}  isDoorbell: ${cam.isDoorbell}`);
    }
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Error:", msg);
  process.exit(1);
}
