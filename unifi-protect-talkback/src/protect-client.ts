import https from "node:https";
import axios, { isAxiosError } from "axios";
import type { AxiosInstance } from "axios";

export type ProtectSession = {
  cookie: string;
  csrfToken: string;
};

export type Camera = {
  id: string;
  name: string;
  type: string;
  state: string;
  model: string;
  marketName: string;
};

const agent = new https.Agent({ rejectUnauthorized: false });

export function createClient(host: string, port = 443): AxiosInstance {
  return axios.create({
    baseURL: `https://${host}:${port}`,
    httpsAgent: agent,
    withCredentials: true,
  });
}

export async function login(
  client: AxiosInstance,
  username: string,
  password: string
): Promise<ProtectSession> {
  try {
    const res = await client.post("/api/auth/login", { username, password });

    const setCookie = res.headers["set-cookie"] ?? [];
    const cookie = setCookie.map((c: string) => c.split(";")[0]).join("; ");
    const csrfToken = (res.headers["x-csrf-token"] as string | undefined) ?? "";

    console.log("[login] OK — csrf:", csrfToken ? "present" : "missing");
    return { cookie, csrfToken };
  } catch (err) {
    if (isAxiosError(err)) {
      throw new Error(`[login] HTTP ${err.response?.status ?? "?"}: ${JSON.stringify(err.response?.data)}`);
    }
    throw err;
  }
}

export async function getTalkbackWsUrl(
  client: AxiosInstance,
  session: ProtectSession,
  cameraId: string
): Promise<string> {
  const endpoint = `/proxy/protect/api/ws/talkback`;
  console.log(`[talkback-ws] GET ${endpoint}?camera=${cameraId}`);

  const res = await client.get(endpoint, {
    params: { camera: cameraId },
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });

  const data = res.data as Record<string, unknown>;
  const url = typeof data["url"] === "string" ? data["url"] : "";

  if (!url) throw new Error(`No url in response: ${JSON.stringify(data)}`);

  // Mask token for logging
  const logUrl = url.replace(/([?&]token=)[^&]+/g, "$1***");
  console.log("[talkback-ws] session URL:", logUrl);

  return url;
}

export async function probeEndpoints(
  client: AxiosInstance,
  session: ProtectSession,
  cameraId: string
): Promise<void> {
  const headers = { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken };
  const candidates = [
    { method: "PUT",  url: `/proxy/protect/api/cameras/${cameraId}/talkback`,         body: { enabled: true } },
    { method: "POST", url: `/proxy/protect/api/cameras/${cameraId}/talkback-session`, body: {} },
    { method: "PUT",  url: `/proxy/protect/api/cameras/${cameraId}/talkback-session`, body: { enabled: true } },
    { method: "PUT",  url: `/proxy/protect/api/cameras/${cameraId}/talkback-stream`,  body: { enabled: true } },
    { method: "GET",  url: `/proxy/protect/api/cameras/${cameraId}`,                  body: null },
  ];

  for (const c of candidates) {
    try {
      const res = c.method === "GET"
        ? await client.get(c.url, { headers })
        : c.method === "POST"
          ? await client.post(c.url, c.body, { headers })
          : await client.put(c.url, c.body, { headers });
      console.log(`[probe] ${c.method} ${c.url} → ${res.status} ✓`);
      console.log(`[probe] response keys: ${Object.keys(res.data as object).join(", ")}`);
    } catch (err) {
      if (isAxiosError(err)) {
        console.log(`[probe] ${c.method} ${c.url} → ${err.response?.status ?? "ERR"} body: ${JSON.stringify(err.response?.data)}`);
      }
    }
  }
}

export async function inspectCameraFields(
  client: AxiosInstance,
  session: ProtectSession,
  cameraId: string
): Promise<void> {
  const res = await client.get(`/proxy/protect/api/cameras/${cameraId}`, {
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  const cam = res.data as Record<string, unknown>;

  const relevant = Object.entries(cam).filter(([k]) =>
    /talk|speaker|feature|channel|audio|mic/i.test(k)
  );
  console.log("[inspect] talkback-related camera fields:");
  for (const [k, v] of relevant) {
    console.log(`  ${k}:`, JSON.stringify(v, null, 2));
  }
  if (relevant.length === 0) {
    console.log("[inspect] none found — all keys:", Object.keys(cam).join(", "));
  }
}

export async function startTalkbackSession(
  client: AxiosInstance,
  session: ProtectSession,
  cameraId: string
): Promise<string> {
  const res = await client.put(
    `/proxy/protect/api/cameras/${cameraId}/talkback`,
    { enabled: true },
    { headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken } }
  );

  const data = res.data as Record<string, unknown>;
  console.log("[talkback-session] response:", JSON.stringify(data, null, 2));

  // Try common response shapes — log all keys if nothing matches
  const nested = data["talkbackStream"] as Record<string, unknown> | undefined;
  const sessionId =
    (typeof nested?.["sessionId"] === "string" ? nested["sessionId"] : undefined) ??
    (typeof data["sessionId"] === "string" ? data["sessionId"] : undefined) ??
    (typeof data["id"] === "string" ? data["id"] : undefined) ??
    "";

  if (sessionId) {
    console.log("[talkback-session] sessionId:", sessionId);
  } else {
    console.warn("[talkback-session] no sessionId found — top-level keys:", Object.keys(data).join(", "));
  }

  return sessionId;
}

export async function stopTalkbackSession(
  client: AxiosInstance,
  session: ProtectSession,
  cameraId: string
): Promise<void> {
  await client.put(
    `/proxy/protect/api/cameras/${cameraId}/talkback`,
    { enabled: false },
    { headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken } }
  );
  console.log("[talkback-session] stopped");
}

export async function getCameras(
  client: AxiosInstance,
  session: ProtectSession
): Promise<Camera[]> {
  const res = await client.get("/proxy/protect/api/cameras", {
    headers: {
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
    },
  });

  const cameras: Camera[] = (res.data as Array<Record<string, unknown>>).map((c) => ({
    id: c["id"] as string,
    name: c["name"] as string,
    type: c["type"] as string,
    state: c["state"] as string,
    model: String(c["modelKey"] ?? c["model"] ?? ""),
    marketName: String(c["marketName"] ?? ""),
  }));

  console.log(`[getCameras] found ${cameras.length} camera(s)`);
  return cameras;
}

export type CameraChannel = {
  id: string;
  name: string;
  rtspAlias: string;
  isRtspEnabled: boolean;
  width: number;
  height: number;
};

export type CameraDetails = {
  id: string;
  name: string;
  type: string;
  state: string;
  channels: CameraChannel[];
  speakerSettings: {
    areSystemSoundsEnabled: boolean;
    isEnabled: boolean;
    volume: number;
    ringVolume: number | null;
    ringtoneId: string | null;
    repeatTimes: number | null;
    speakerVolume: number | null;
  } | null;
  micVolume: number | null;
  lcdMessage: { type: string; text: string; resetAt: number | null } | null;
  featureFlags: {
    hasSpeaker: boolean;
    hasLcdScreen: boolean;
    hasChime: boolean;
    supportCustomRingtone: boolean;
  };
};

export async function getCameraDetails(
  client: AxiosInstance,
  session: ProtectSession,
  cameraId: string
): Promise<CameraDetails> {
  const res = await client.get(`/proxy/protect/api/cameras/${cameraId}`, {
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  const cam = res.data as Record<string, unknown>;

  const channels: CameraChannel[] = Array.isArray(cam["channels"])
    ? (cam["channels"] as Array<Record<string, unknown>>).map((ch) => ({
        id: String(ch["id"] ?? ""),
        name: String(ch["name"] ?? ""),
        rtspAlias: String(ch["rtspAlias"] ?? ""),
        isRtspEnabled: Boolean(ch["isRtspEnabled"]),
        width: Number(ch["width"] ?? 0),
        height: Number(ch["height"] ?? 0),
      }))
    : [];

  const flags = (cam["featureFlags"] as Record<string, unknown>) ?? {};
  const speaker = cam["speakerSettings"] as Record<string, unknown> | null | undefined;
  const lcd = cam["lcdMessage"] as Record<string, unknown> | null | undefined;

  return {
    id: String(cam["id"] ?? ""),
    name: String(cam["name"] ?? ""),
    type: String(cam["type"] ?? ""),
    state: String(cam["state"] ?? ""),
    channels,
    speakerSettings: speaker
      ? {
          areSystemSoundsEnabled: Boolean(speaker["areSystemSoundsEnabled"]),
          isEnabled: Boolean(speaker["isEnabled"]),
          volume: Number(speaker["volume"] ?? 0),
          ringVolume: typeof speaker["ringVolume"] === "number" ? speaker["ringVolume"] : null,
          ringtoneId: typeof speaker["ringtoneId"] === "string" ? speaker["ringtoneId"] : null,
          repeatTimes: typeof speaker["repeatTimes"] === "number" ? speaker["repeatTimes"] : null,
          speakerVolume: typeof speaker["speakerVolume"] === "number" ? speaker["speakerVolume"] : null,
        }
      : null,
    micVolume: typeof cam["micVolume"] === "number" ? cam["micVolume"] : null,
    lcdMessage: lcd
      ? {
          type: String(lcd["type"] ?? ""),
          text: String(lcd["text"] ?? ""),
          resetAt: typeof lcd["resetAt"] === "number" ? lcd["resetAt"] : null,
        }
      : null,
    featureFlags: {
      hasSpeaker: Boolean(flags["hasSpeaker"]),
      hasLcdScreen: Boolean(flags["hasLcdScreen"]),
      hasChime: Boolean(flags["hasChime"]),
      supportCustomRingtone: Boolean(flags["supportCustomRingtone"]),
    },
  };
}

export async function updateCameraSettings(
  client: AxiosInstance,
  session: ProtectSession,
  cameraId: string,
  settings: Record<string, unknown>
): Promise<void> {
  await client.patch(`/proxy/protect/api/cameras/${cameraId}`, settings, {
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
}

export async function setDisplayMessage(
  client: AxiosInstance,
  session: ProtectSession,
  cameraId: string,
  message: { type: string; text?: string; resetAt?: number | null } | null
): Promise<void> {
  await client.patch(
    `/proxy/protect/api/cameras/${cameraId}`,
    { lcdMessage: message },
    { headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken } }
  );
}

export type Ringtone = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type ChimeRingSettings = {
  cameraId: string;
  volume: number;
  ringtoneId: string;
  repeatTimes: number;
};

export type ChimeDevice = {
  id: string;
  name: string;
  type: string;
  state: string;
  volume: number;
  repeatTimes: number;
  ringSettings: ChimeRingSettings[];
  featureFlags: { supportCustomRingtone: boolean };
};

export async function getRingtones(
  client: AxiosInstance,
  session: ProtectSession
): Promise<Ringtone[]> {
  const res = await client.get("/proxy/protect/api/ringtones", {
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  return (res.data as Array<Record<string, unknown>>).map((r) => ({
    id: String(r["id"] ?? ""),
    name: String(r["name"] ?? ""),
    isDefault: Boolean(r["isDefault"]),
  }));
}

export async function getChimeDevices(
  client: AxiosInstance,
  session: ProtectSession
): Promise<ChimeDevice[]> {
  const res = await client.get("/proxy/protect/api/chimes", {
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
  return (res.data as Array<Record<string, unknown>>).map((c) => {
    const raw = (c["ringSettings"] ?? []) as Array<Record<string, unknown>>;
    const flags = (c["featureFlags"] as Record<string, unknown>) ?? {};
    return {
      id: String(c["id"] ?? ""),
      name: String(c["name"] ?? ""),
      type: String(c["type"] ?? ""),
      state: String(c["state"] ?? ""),
      volume: Number(c["volume"] ?? 0),
      repeatTimes: Number(c["repeatTimes"] ?? 1),
      ringSettings: raw.map((rs) => ({
        cameraId: String(rs["cameraId"] ?? ""),
        volume: Number(rs["volume"] ?? 0),
        ringtoneId: String(rs["ringtoneId"] ?? ""),
        repeatTimes: Number(rs["repeatTimes"] ?? 1),
      })),
      featureFlags: { supportCustomRingtone: Boolean(flags["supportCustomRingtone"]) },
    };
  });
}

export async function updateChimeDevice(
  client: AxiosInstance,
  session: ProtectSession,
  chimeId: string,
  data: Record<string, unknown>
): Promise<void> {
  await client.patch(`/proxy/protect/api/chimes/${chimeId}`, data, {
    headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken },
  });
}
