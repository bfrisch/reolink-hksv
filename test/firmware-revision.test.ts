import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFirmwareRevision } from "../src/reolink.ts";

test("parses live Elite Floodlight firmVer into HomeKit x.y.z", () => {
  // Observed from Garage Side / Garage Entryway GetDevInfo.
  assert.equal(parseFirmwareRevision("v3.2.0.6530_2606232191"), "3.2.6530");
});

test("parses other common Reolink firmVer shapes", () => {
  assert.equal(parseFirmwareRevision("v3.0.0.1817_23022701"), "3.0.1817");
  assert.equal(parseFirmwareRevision("v3.1.0.3909_2408064516"), "3.1.3909");
  assert.equal(parseFirmwareRevision("V2.1.0.1000_21010101"), "2.1.1000");
});

test("keeps already-numeric three-part versions", () => {
  assert.equal(parseFirmwareRevision("3.2.0"), "3.2.0");
  assert.equal(parseFirmwareRevision("1.0"), "1.0");
  assert.equal(parseFirmwareRevision("100"), "100");
});

test("returns undefined for unusable values", () => {
  assert.equal(parseFirmwareRevision(""), undefined);
  assert.equal(parseFirmwareRevision("build only"), undefined);
  assert.equal(parseFirmwareRevision("v_"), undefined);
});
