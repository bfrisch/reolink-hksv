import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AccessoryIdentity {
  username: string;
  pincode: string;
  setupID: string;
}

interface Store {
  [cameraKey: string]: AccessoryIdentity;
}

const INVALID_PINS = new Set([
  "000-00-000",
  "111-11-111",
  "222-22-222",
  "333-33-333",
  "444-44-444",
  "555-55-555",
  "666-66-666",
  "777-77-777",
  "888-88-888",
  "999-99-999",
  "123-45-678",
  "876-54-321",
]);

function digest(input: string, salt = ""): Buffer {
  return createHash("sha1").update(salt + input).digest();
}

function macFromSeed(seed: string): string {
  const h = digest(seed, "mac:");
  const b = Buffer.from(h.subarray(0, 6));
  b[0] = (b[0] | 0x02) & 0xfe;
  return [...b].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function pinFromSeed(seed: string, attempt = 0): string {
  const n = digest(seed, `pin:${attempt}`).readUInt32BE(0) % 1_000_000_000;
  const s = n.toString().padStart(8, "0").slice(0, 8);
  const pin = `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5, 8)}`;
  if (INVALID_PINS.has(pin)) return pinFromSeed(seed, attempt + 1);
  return pin;
}

function setupIdFromSeed(seed: string): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const h = digest(seed, "setup:");
  let id = "";
  for (let i = 0; i < 4; i++) id += alphabet[h[i] % alphabet.length];
  return id;
}

export function loadIdentities(storageDir: string): Store {
  mkdirSync(storageDir, { recursive: true });
  const path = join(storageDir, "identities.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch {
    return {};
  }
}

export function saveIdentities(storageDir: string, store: Store): void {
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, "identities.json"), JSON.stringify(store, null, 2));
}

export function identityFor(storageDir: string, key: string): AccessoryIdentity {
  const store = loadIdentities(storageDir);
  if (store[key]) return store[key];
  const identity = {
    username: macFromSeed(key),
    pincode: pinFromSeed(key),
    setupID: setupIdFromSeed(key),
  };
  store[key] = identity;
  saveIdentities(storageDir, store);
  return identity;
}
