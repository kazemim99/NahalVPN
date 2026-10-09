// Behaviour tests for NahalVPN app accounts created from the panel (task 9.1).
//
// Business rules under test:
//   * Default app usernames are the reseller's prefix in lower case plus a number starting at 1001, so they are
//     told apart from x-ui client names (M101) and never reuse a number the reseller already has.
//   * Generated passwords are 4-digit codes (owner's choice), easy to read out and type.
//
// Run with:  node panel/tests/app-accounts.test.js
"use strict";

const assert = require("assert");
const { nextAppUsername, randomAppPassword } = require("../server-ir2.js");

let passed = 0;
function it(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log("app accounts: usernames and passwords");

it("first account of a reseller is <prefix>1001 in lower case", () => {
  assert.strictEqual(nextAppUsername("M", []), "m1001");
});

it("next number follows the highest existing one, ignoring other names and other prefixes", () => {
  const users = [{ username: "m1001" }, { username: "m1007" }, { username: "custom-name" }, { username: "r2000" }, { username: "M1003" }];
  assert.strictEqual(nextAppUsername("M", users), "m1008");
  assert.strictEqual(nextAppUsername("R", users), "r2001");
});

it("passwords are 4-digit codes (leading zeros kept) and vary between calls", () => {
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const p = randomAppPassword();
    assert.match(p, /^\d{4}$/);
    seen.add(p);
  }
  assert.ok(seen.size > 200, "codes should vary");
});

console.log(`\n${passed} passed`);
