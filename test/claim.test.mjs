import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLAIM_ORIGIN,
  isLoopbackCallbackOrigin,
  mapCallbackOrigin,
  normalizeClaimOrigin,
} from "../src/claim.js";

test("normalizeClaimOrigin accepts exactly what upstream's loginOrigin accepts", () => {
  assert.equal(normalizeClaimOrigin("http://127.0.0.1:47821"), "http://127.0.0.1:47821");
  assert.equal(normalizeClaimOrigin("http://127.0.0.1:47821/"), "http://127.0.0.1:47821");
  assert.equal(normalizeClaimOrigin("http://localhost:3081"), "http://localhost:3081");
  assert.equal(normalizeClaimOrigin("http://[::1]:8080"), "http://[::1]:8080");
  assert.equal(normalizeClaimOrigin(DEFAULT_CLAIM_ORIGIN), DEFAULT_CLAIM_ORIGIN);
});

test("normalizeClaimOrigin refuses everything upstream would refuse", () => {
  const refused = [
    undefined,
    null,
    42,
    "",
    "   ",
    "https://127.0.0.1:47821", // the platform wants plain http for loopback
    "http://192.168.3.2:47821", // not a loopback host
    "http://dsh.example.com:47821",
    "http://127.0.0.1", // no explicit port
    "http://127.0.0.1:0",
    "http://127.0.0.1:70000",
    "http://user@127.0.0.1:47821",
    "http://127.0.0.1:47821/path",
    "http://127.0.0.1:47821?query=1",
    "http://127.0.0.1:47821#fragment",
    "not a url",
  ];
  for (const value of refused) {
    assert.equal(normalizeClaimOrigin(value), null, `expected ${JSON.stringify(value)} to be refused`);
  }
});

test("a claim is only substituted for a browser that is not already on loopback", () => {
  const claim = "http://127.0.0.1:47821";
  assert.equal(isLoopbackCallbackOrigin("http://127.0.0.1:3081"), true);
  assert.equal(isLoopbackCallbackOrigin("http://localhost:3081"), true);
  assert.equal(isLoopbackCallbackOrigin("https://dsh.example.com"), false);

  // Pass-through keeps upstream behaviour bit-for-bit for tunnels and the desktop app.
  assert.equal(mapCallbackOrigin("http://127.0.0.1:3081", claim), "http://127.0.0.1:3081");
  assert.equal(mapCallbackOrigin("http://localhost:3081", claim), "http://localhost:3081");
  assert.equal(mapCallbackOrigin("https://dsh.example.com", claim), claim);
  assert.equal(mapCallbackOrigin("http://192.168.3.2:3080", claim), claim);
});
