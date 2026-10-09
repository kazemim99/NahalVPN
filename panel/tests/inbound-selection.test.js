// Which inbound do new and renewed accounts land on?
//
// Background: x-ui refuses the same email on two inbounds ("Duplicate email"), so a
// client lives on exactly one. Moving to the WS+TLS inbound is therefore a migration:
// new accounts are created there, and renewing an old account moves it there.
//
// Run with:  node panel/tests/inbound-selection.test.js
"use strict";

const assert = require("assert");
const { pickCreateInbound } = require("../server-ir2.js");

let passed = 0;
function it(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const wstls = { id: 8, remark: "WS-TLS", port: 53726, enable: true };
const cdn   = { id: 3, remark: "Arvan-CDN", port: 8080, enable: true };
const n     = { id: 1, remark: "N", port: 443, enable: true };

console.log("inbound selection for create/renew");

it("prefers the WS-TLS inbound when it exists", () => {
  assert.strictEqual(pickCreateInbound([cdn, wstls, n]).id, 8);
});

it("order in the list does not matter", () => {
  assert.strictEqual(pickCreateInbound([wstls, cdn]).id, 8);
  assert.strictEqual(pickCreateInbound([cdn, wstls]).id, 8);
});

it("falls back to the CDN inbound when WS-TLS is absent", () => {
  assert.strictEqual(pickCreateInbound([n, cdn]).id, 3, "preserves old behaviour on other servers");
});

it("falls back to the first inbound when neither is present", () => {
  assert.strictEqual(pickCreateInbound([n]).id, 1);
});

it("skips a disabled WS-TLS inbound rather than sending clients into a dead endpoint", () => {
  assert.strictEqual(pickCreateInbound([{ ...wstls, enable: false }, cdn]).id, 3);
});

it("treats a missing enable flag as enabled", () => {
  const noFlag = { id: 8, remark: "WS-TLS", port: 53726 };
  assert.strictEqual(pickCreateInbound([noFlag, cdn]).id, 8);
});

it("returns null for an empty or invalid list instead of throwing", () => {
  assert.strictEqual(pickCreateInbound([]), null);
  assert.strictEqual(pickCreateInbound(null), null);
  assert.strictEqual(pickCreateInbound(undefined), null);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
process.exit(process.exitCode || 0);
