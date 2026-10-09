// Behaviour tests for sales/order accounting in the admin dashboard.
//
// Business rules under test:
//   * One "order" is counted per month of the plan — a 3-month plan is three
//     orders, not one.
//   * A renewal (تمدید) is a sale exactly like a fresh account, and counts by
//     the same month rule.
//   * Log entries written before this rule existed have no `months` and count
//     as a single order, so historical totals do not change retroactively.
//   * A renewal must not move a client's "created at" date.
//
// Run with:  node panel/tests/sold-stats.test.js
"use strict";

const assert = require("assert");
const { entryOrders, aggregateSoldStats, buildCreatedMap, parseDaysParam } = require("../server-ir2.js");

let passed = 0;
function it(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

const ADMINS = ["mostafa", "ali", "ramin"];
const agg = (log, since = 0) => aggregateSoldStats(log, { since, admins: ADMINS });
const create = (admin, months, ts = 1000) => ({ email: "M1", admin, ts, months, type: "create" });
const renew = (admin, months, ts = 1000) => ({ email: "M1", admin, ts, months, type: "renew" });

console.log("sold-stats: order counting");

it("a 1-month sale counts as one order", () => {
  assert.strictEqual(agg([create("mostafa", 1)]).counts.mostafa, 1);
});

it("a 2-month sale counts as two orders", () => {
  assert.strictEqual(agg([create("mostafa", 2)]).counts.mostafa, 2);
});

it("a 3-month sale counts as three orders", () => {
  assert.strictEqual(agg([create("mostafa", 3)]).counts.mostafa, 3);
});

it("a 6-month sale counts as six orders", () => {
  assert.strictEqual(agg([create("mostafa", 6)]).counts.mostafa, 6);
});

console.log("sold-stats: renewals are sales");

it("renewing for 2 months adds two orders for the renewing admin", () => {
  assert.strictEqual(agg([renew("mostafa", 2)]).counts.mostafa, 2);
});

it("renewing for 3 months adds three orders", () => {
  assert.strictEqual(agg([renew("mostafa", 3)]).counts.mostafa, 3);
});

it("a create plus a later renewal both count", () => {
  const r = agg([create("mostafa", 1, 1000), renew("mostafa", 2, 2000)]);
  assert.strictEqual(r.counts.mostafa, 3, "1-month create + 2-month renew = 3 orders");
  assert.strictEqual(r.detail.mostafa.created, 1);
  assert.strictEqual(r.detail.mostafa.renewed, 1);
  assert.strictEqual(r.detail.mostafa.transactions, 2, "two separate transactions");
});

it("orders are credited to the admin who made the sale", () => {
  const r = agg([create("mostafa", 2), renew("ali", 3)]);
  assert.strictEqual(r.counts.mostafa, 2);
  assert.strictEqual(r.counts.ali, 3);
  assert.strictEqual(r.total, 5);
});

console.log("sold-stats: legacy + edge cases");

it("legacy entries without months still count as one order", () => {
  const legacy = { email: "Akaskas", admin: "ali", ts: 1785850999399 };
  assert.strictEqual(entryOrders(legacy), 1);
  assert.strictEqual(agg([legacy]).counts.ali, 1);
});

it("a nonsensical months value falls back to one order", () => {
  for (const bad of [0, -3, null, "abc", NaN, undefined]) {
    assert.strictEqual(entryOrders({ admin: "ali", ts: 1, months: bad }), 1, `months=${String(bad)}`);
  }
});

it("an absurdly large months value is clamped, not trusted", () => {
  assert.strictEqual(entryOrders({ admin: "ali", ts: 1, months: 99999 }), 12);
});

it("admins with no sales in the window still report zero", () => {
  const r = agg([create("mostafa", 2)]);
  assert.strictEqual(r.counts.ramin, 0);
  assert.ok("ali" in r.counts, "every known admin is listed");
});

it("entries older than the window are excluded", () => {
  const log = [create("mostafa", 3, 1000), create("mostafa", 2, 5000)];
  assert.strictEqual(agg(log, 4000).counts.mostafa, 2, "only the in-window sale counts");
  assert.strictEqual(agg(log, 0).counts.mostafa, 5, "since=0 means all time");
});

it("malformed entries are skipped instead of crashing the report", () => {
  const r = agg([null, {}, { admin: "ali" }, { ts: 5 }, create("mostafa", 2)]);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.counts.mostafa, 2);
});

it("total equals the sum of every admin's orders", () => {
  const r = agg([create("mostafa", 2), renew("ali", 6), create("ramin", 1)]);
  const sum = Object.values(r.counts).reduce((s, n) => s + n, 0);
  assert.strictEqual(r.total, sum);
  assert.strictEqual(r.total, 9);
});

console.log("client list: renewals do not rewrite creation dates");

it("createdAt stays at the original creation, not the renewal", () => {
  const log = [
    { email: "Mreza4", admin: "mostafa", ts: 1000, months: 1, type: "create" },
    { email: "Mreza4", admin: "mostafa", ts: 9000, months: 2, type: "renew" },
  ];
  assert.strictEqual(buildCreatedMap(log).get("mreza4"), 1000);
});

it("a re-created email (deleted, then sold again) takes the newer creation date", () => {
  const log = [
    { email: "Mreza4", admin: "mostafa", ts: 1000, months: 1, type: "create" },
    { email: "Mreza4", admin: "ali", ts: 9000, months: 1, type: "create" },
  ];
  assert.strictEqual(buildCreatedMap(log).get("mreza4"), 9000);
});

it("legacy entries with no type are treated as creations", () => {
  assert.strictEqual(buildCreatedMap([{ email: "Akaskas", admin: "ali", ts: 42 }]).get("akaskas"), 42);
});

console.log("sold-stats: period filter");

it("days=0 means all time, not the last day", () => {
  assert.strictEqual(parseDaysParam("0"), 0);
});

it("no days parameter means all time", () => {
  assert.strictEqual(parseDaysParam(null), 0);
  assert.strictEqual(parseDaysParam(""), 0);
});

it("month filters pass through unchanged", () => {
  assert.strictEqual(parseDaysParam("30"), 30);
  assert.strictEqual(parseDaysParam("60"), 60);
  assert.strictEqual(parseDaysParam("90"), 90);
});

it("garbage and negative values fall back to all time", () => {
  assert.strictEqual(parseDaysParam("abc"), 0);
  assert.strictEqual(parseDaysParam("-5"), 0);
});

console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
process.exit(process.exitCode || 0);
