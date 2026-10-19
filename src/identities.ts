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

/**
 * SHA-1 digest used as the seed for every accessory identity field.
 * The salt keeps MAC, PIN, and setup ID independent of each other.
 *
 * @param input - camera key or other stable seed
 * @param salt - domain prefix so each field hashes differently
 * @returns raw digest bytes
 */
function digest(input: string, salt = ""): Buffer {
  return createHash("sha1").update(salt + input).digest();
}

/**
 * Build a stable MAC address HomeKit can use as the accessory username.
 * The first octet is forced to a locally administered unicast address.
 *
 * @param seed - camera key
 * @returns uppercase colon-separated MAC
 */
function macFromSeed(seed: string): string {
  const h = digest(seed, "mac:");
  const b = Buffer.from(h.subarray(0, 6));
  // Locally administered (bit 1) and unicast (clear the multicast bit).
  b[0] = (b[0] | 0x02) & 0xfe;
  return [...b].map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

/**
 * Build an 8-digit HomeKit PIN (`XXX-XX-XXX`) from the camera key.
 * HomeKit rejects repeated and sequential codes, so those are retried.
 *
 * @param seed - camera key
 * @param attempt - retry counter mixed into the hash when a PIN is rejected
 * @returns formatted pairing PIN
 */
function pinFromSeed(seed: string, attempt = 0): string {
  const n = digest(seed, `pin:${attempt}`).readUInt32BE(0) % 1_000_000_000;
  const s = n.toString().padStart(8, "0").slice(0, 8);
  const pin = `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5, 8)}`;
  if (INVALID_PINS.has(pin)) return pinFromSeed(seed, attempt + 1);
  return pin;
}

/**
 * Build the 4-character HomeKit setup ID printed next to the QR code.
 *
 * @param seed - camera key
 * @returns four characters from the HomeKit setup alphabet
 */
function setupIdFromSeed(seed: string): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const h = digest(seed, "setup:");
  let id = "";
  for (let i = 0; i < 4; i++) id += alphabet[h[i] % alphabet.length];
  return id;
}

/**
 * Load previously generated accessory identities, or an empty store.
 * A missing or unreadable file is treated as "nothing paired yet".
 *
 * @param storageDir - directory that holds `identities.json`
 * @returns identities keyed by camera
 */
export function loadIdentities(storageDir: string): Store {
  mkdirSync(storageDir, { recursive: true });
  const path = join(storageDir, "identities.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch {
    return {};
  }
}

/**
 * Persist accessory identities so pairings survive a restart.
 *
 * @param storageDir - directory that holds `identities.json`
 * @param store - full identity map to write
 */
export function saveIdentities(storageDir: string, store: Store): void {
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, "identities.json"), JSON.stringify(store, null, 2));
}

/**
 * Return the stable HomeKit identity for a camera, creating it on first use.
 * The same key always yields the same username, PIN, and setup ID.
 *
 * @param storageDir - directory that holds `identities.json`
 * @param key - stable camera key (`host:channel:name`)
 * @returns pairing identity for that camera
 */
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
