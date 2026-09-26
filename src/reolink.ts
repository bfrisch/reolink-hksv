import type { CameraConfig } from "./config.js";
import { log } from "./logger.js";

interface TokenValue {
  Token?: { name: string; leaseTime?: number };
}

export class ReolinkClient {
  private token?: string;
  private tokenUntil = 0;

  constructor(private readonly cam: CameraConfig) {}

  private base(): string {
    return `http://${this.cam.host}:${this.cam.port}`;
  }

  async login(): Promise<void> {
    const url = `${this.base()}/cgi-bin/api.cgi?cmd=Login`;
    const body = [
      {
        cmd: "Login",
        param: { User: { userName: this.cam.username, password: this.cam.password } },
      },
    ];
    const res = await fetch(url, {
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
    const res = await fetch(url, {
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

  async deviceInfo(): Promise<Record<string, unknown>> {
    const value = await this.cmd<{ DevInfo?: Record<string, unknown> }>("GetDevInfo");
    return value.DevInfo ?? (value as Record<string, unknown>);
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
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Snapshot HTTP ${res.status} for ${this.cam.name}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
