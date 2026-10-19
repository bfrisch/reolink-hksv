import onvif from "onvif";
import type { CameraConfig, VideoStreamName } from "./config.js";
import { log } from "./logger.js";

const { Cam } = onvif;

interface OnvifProfile {
  token?: string;
  name?: unknown;
  $?: { token?: string };
}

/**
 * Profile token from either the parsed field or the raw XML attribute.
 *
 * @param profile - one ONVIF media profile
 * @returns token, or undefined when the camera omitted it
 */
function profileToken(profile: OnvifProfile): string | undefined {
  return profile.token ?? profile.$?.token;
}

/**
 * Flatten an ONVIF text node. The library sometimes returns a string and sometimes `{ _: "text" }`.
 *
 * @param value - raw profile field
 * @returns a plain string, empty when the value is missing
 */
function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  // xml2js text nodes are objects with a "_" property.
  if (typeof value === "object" && "_" in (value as object)) return String((value as { _: unknown })._);
  return String(value);
}

/**
 * Human-readable profile name, falling back to the token.
 *
 * @param profile - one ONVIF media profile
 * @returns label used for matching and logs
 */
function profileLabel(profile: OnvifProfile): string {
  return asText(profile.name) || asText(profileToken(profile));
}

/**
 * Hide the password in an RTSP URL before it is written to the log.
 *
 * @param uri - URL that may contain userinfo
 * @returns the same URL with the password replaced by `****`
 */
function sanitize(uri: string): string {
  return uri.replace(/:[^:@/]+@/, ":****@");
}

/**
 * Put the configured credentials on an ONVIF stream URI and force it to RTSP.
 * Some cameras return `0.0.0.0` or a loopback host; those are replaced with the configured host.
 *
 * @param uri - URI from GetStreamUri
 * @param username - RTSP username
 * @param password - RTSP password
 * @param host - camera address from config
 * @returns an `rtsp://user:pass@host/...` URL
 */
function withCredentials(uri: string, username: string, password: string, host: string): string {
  const raw = uri.includes("://") ? uri : `rtsp://${uri}`;
  const parsed = new URL(raw);
  parsed.username = username;
  parsed.password = password;
  if (!parsed.hostname || parsed.hostname === "0.0.0.0" || parsed.hostname === "127.0.0.1") {
    parsed.hostname = host;
  }
  if (parsed.protocol !== "rtsp:") parsed.protocol = "rtsp:";
  return parsed.toString();
}

/**
 * Open an ONVIF session on one port.
 *
 * @param cam - camera connection settings
 * @param port - ONVIF device-service port
 * @returns a connected Cam client
 */
function connect(cam: CameraConfig, port: number): Promise<Cam> {
  return new Promise((resolve, reject) => {
    const client = new Cam(
      {
        hostname: cam.host,
        username: cam.username,
        password: cam.password,
        port,
        timeout: 4000,
        preserveAddress: true,
      },
      (err: Error | null) => {
        if (err) reject(err);
        else resolve(client);
      },
    );
  });
}

/**
 * List media profiles on an already connected client.
 *
 * @param client - connected ONVIF client
 * @returns profiles, which may be empty
 */
function getProfiles(client: Cam): Promise<OnvifProfile[]> {
  return new Promise((resolve, reject) => {
    client.getProfiles((err: Error | null, profiles?: OnvifProfile[]) => {
      if (err) reject(err);
      else resolve((profiles ?? []) as OnvifProfile[]);
    });
  });
}

/**
 * Ask ONVIF for the RTSP URI of one profile.
 *
 * @param client - connected ONVIF client
 * @param profileTokenValue - media profile token
 * @returns the stream URI, still without our credentials applied
 */
function getStreamUri(client: Cam, profileTokenValue: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.getStreamUri(
      { protocol: "RTSP", profileToken: profileTokenValue, stream: "RTP-Unicast" },
      (err: Error | null, stream?: { uri?: string }) => {
        if (err) reject(err);
        else if (!stream?.uri) reject(new Error("ONVIF GetStreamUri returned no uri"));
        else resolve(stream.uri);
      },
    );
  });
}

/**
 * Choose the media profile that matches the configured channel and stream quality.
 * Names are preferred; when they do not mention the channel, profiles are sliced by index.
 *
 * @param profiles - profiles returned by the camera
 * @param stream - main, sub, or ext
 * @param channel - 0-based NVR channel
 * @returns the best profile, or undefined when the list is empty
 */
function pickProfile(profiles: OnvifProfile[], stream: VideoStreamName, channel: number): OnvifProfile | undefined {
  if (!profiles.length) return undefined;

  // Reolink labels vary: "ch01", "channel 1", or a `_01_` path fragment.
  const channelHint = [
    `ch${channel + 1}`,
    `ch0${channel + 1}`,
    `channel${channel + 1}`,
    `channel ${channel + 1}`,
    `_${String(channel + 1).padStart(2, "0")}_`,
  ];
  const matching = profiles.filter((p) => {
    const label = profileLabel(p).toLowerCase().replace(/\s+/g, "");
    return channelHint.some((h) => label.includes(h.replace(/\s+/g, "")));
  });
  // NVRs often list two or three profiles per channel. Slice that window when names do not match.
  const pool = matching.length ? matching : channel > 0 ? profiles.slice(channel * 2, channel * 2 + 3) : profiles;
  const list = pool.length ? pool : profiles;

  const ranked = [...list].sort((a, b) => {
    const al = profileLabel(a).toLowerCase();
    const bl = profileLabel(b).toLowerCase();
    // Lower score is a better match for the requested stream.
    const score = (name: string) => {
      if (stream === "sub") return name.includes("sub") || name.includes("second") ? 0 : 1;
      if (stream === "ext") return name.includes("ext") || name.includes("third") ? 0 : 1;
      return name.includes("main") || name.includes("primary") ? 0 : name.includes("sub") ? 2 : 1;
    };
    return score(al) - score(bl);
  });

  // If names are ambiguous, fall back to profile order: main, sub, ext.
  const idx = stream === "sub" ? Math.min(1, ranked.length - 1) : stream === "ext" ? Math.min(2, ranked.length - 1) : 0;
  return ranked[idx] ?? ranked[0];
}

const DEFAULT_ONVIF_PORTS = [8000, 80, 8080, 2020, 8899];

/**
 * Discover an authenticated RTSP URL through ONVIF.
 * Tries the configured port first, then the common Reolink ONVIF ports.
 *
 * @param cam - camera connection settings
 * @returns an RTSP URL, or undefined when ONVIF is disabled or every port fails
 */
export async function fetchOnvifRtsp(cam: CameraConfig): Promise<string | undefined> {
  if (cam.onvif === false) return undefined;

  const ports = cam.onvifPort ? [cam.onvifPort, ...DEFAULT_ONVIF_PORTS.filter((p) => p !== cam.onvifPort)] : DEFAULT_ONVIF_PORTS;
  let lastError: unknown;

  for (const port of ports) {
    try {
      // The library's own timeout is not always honored, so race it with a hard limit.
      const client = await Promise.race([
        connect(cam, port),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ONVIF connect timeout")), 5000)),
      ]);
      const profiles = await getProfiles(client);
      const profile = pickProfile(profiles, cam.videoStream, cam.channel);
      const token = profile ? profileToken(profile) : undefined;
      if (!token) {
        lastError = new Error(`no ONVIF media profile on port ${port}`);
        continue;
      }
      const uri = await getStreamUri(client, token);
      const withAuth = withCredentials(uri, cam.username, cam.password, cam.host);
      log.info(
        `${cam.name}: ONVIF ${cam.host}:${port} profile "${profileLabel(profile)}" → ${sanitize(withAuth)}`,
      );
      return withAuth;
    } catch (err) {
      lastError = err;
      log.debug(false, `${cam.name}: ONVIF port ${port} failed: ${String(err)}`);
    }
  }

  log.warn(`${cam.name}: ONVIF did not return an RTSP URL (${String(lastError)})`);
  return undefined;
}
