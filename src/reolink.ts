import http from "node:http";
import https from "node:https";
import type { CameraConfig } from "./config.js";
import { log } from "./logger.js";

interface TokenValue {
  Token?: { name: string; leaseTime?: number };
}

/** Device info from Reolink `GetDevInfo`. */
export type DevInfo = {
  firmVer?: string;
  model?: string;
  serial?: string;
  name?: string;
  hardVer?: string;
  [key: string]: unknown;
};

interface CameraResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Local Reolink APIs often use self-signed TLS; do not reject those certs. */
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

async function cameraFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<CameraResponse> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method ?? "GET",
        headers: init.headers,
        agent: isHttps ? insecureHttpsAgent : undefined,
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            async json() {
              return JSON.parse(buf.toString("utf8")) as unknown;
            },
            async arrayBuffer() {
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            },
          });
        });
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

export class ReolinkClient {
  private token?: string;
  private tokenUntil = 0;

  constructor(private readonly cam: CameraConfig) {}

  private base(): string {
    const scheme = this.cam.https ? "https" : "http";
    return `${scheme}://${this.cam.host}:${this.cam.port}`;
  }

  async login(): Promise<void> {
    const url = `${this.base()}/cgi-bin/api.cgi?cmd=Login`;
    const body = [
      {
        cmd: "Login",
        param: { User: { userName: this.cam.username, password: this.cam.password } },
      },
    ];
    const res = await cameraFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Login HTTP ${res.status} for ${this.cam.name}`);
    const json = (await res.json()) as Array<{ code?: number; value?: TokenValue; error?: unknown }>;
    const token = json[0]?.value?.Token?.name;
    if (!token) {
      throw new Error(`Login failed for ${this.cam.name}: ${JSON.stringify(json[0])}`);
    }
    const lease = json[0]?.value?.Token?.leaseTime ?? 3600;
    this.token = token;
    this.tokenUntil = Date.now() + Math.max(30, lease - 60) * 1000;
  }

  private async ensureToken(): Promise<string> {
    if (!this.token || Date.now() > this.tokenUntil) await this.login();
    return this.token!;
  }

  async cmd<T = unknown>(cmd: string, param: Record<string, unknown> = {}): Promise<T> {
    const token = await this.ensureToken();
    const url = `${this.base()}/cgi-bin/api.cgi?cmd=${encodeURIComponent(cmd)}&token=${encodeURIComponent(token)}`;
    const res = await cameraFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ cmd, action: 0, param }]),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`${cmd} HTTP ${res.status} for ${this.cam.name}`);
    const json = (await res.json()) as Array<{ code?: number; value?: T; error?: unknown }>;
    const row = json[0];
    if (row?.code !== 0 && row?.code !== undefined) {
      this.token = undefined;
      throw new Error(`${cmd} failed for ${this.cam.name}: ${JSON.stringify(row)}`);
    }
    return row.value as T;
  }

  async deviceInfo(): Promise<DevInfo> {
    const value = await this.cmd<{ DevInfo?: DevInfo }>("GetDevInfo");
    return value.DevInfo ?? (value as DevInfo);
  }

  async motionActive(): Promise<boolean> {
    try {
      const md = await this.cmd<{ state?: number }>("GetMdState", { channel: this.cam.channel });
      if (md?.state) return true;
    } catch (err) {
      log.warn(`${this.cam.name}: GetMdState failed: ${String(err)}`);
    }

    try {
      const ai = await this.cmd<Record<string, { alarm_state?: number } | unknown>>(
        "GetAiState",
        { channel: this.cam.channel },
      );
      for (const key of ["people", "vehicle", "dog_cat", "face", "package"]) {
        const item = ai?.[key];
        if (
          item &&
          typeof item === "object" &&
          "alarm_state" in item &&
          (item as { alarm_state?: number }).alarm_state
        ) {
          return true;
        }
      }
    } catch {
      // Older cameras may not expose AI state.
    }

    return false;
  }

  async snapshot(): Promise<Buffer> {
    const token = await this.ensureToken();
    const url =
      this.cam.snapshotUrl ??
      `${this.base()}/cgi-bin/api.cgi?cmd=Snap&channel=${this.cam.channel}&rs=${Date.now()}&token=${encodeURIComponent(token)}`;
    const res = await cameraFetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Snapshot HTTP ${res.status} for ${this.cam.name}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
