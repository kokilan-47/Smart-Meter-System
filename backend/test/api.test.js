/* Integration tests: the real Express app + a real MongoDB, in a throwaway database that is
   created and deleted by the tests (your normal data is never touched). Run with: npm test */
process.env.NODE_ENV = "test";
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zenplug_enroll_test";
process.env.JWT_SECRET = "test-secret-not-used-anywhere-else";
process.env.METER_INGEST_TOKEN = "test-meter-token";
process.env.LOGIN_ATTEMPTS = "8";
process.env.REGISTER_ATTEMPTS = "100";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { app, seedDefaults, runPeriodicChecks, applyTariffs, faultConditions, parseMeterPayload } = require("../server");
const User = require("../models/User");
const Meter = require("../models/Meter");
const MeterReading = require("../models/MeterReading");
const Bill = require("../models/Bill");
const Fault = require("../models/Fault");

let server, base, adminToken;
const METER_HEADERS = { Authorization: "Bearer test-meter-token" };

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null; try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}
const login = async (email, password) => (await call("POST", "/api/auth/login", { body: { email, password } }));
const reading = (meter_id, extra = {}) => ({ meter_id, voltage_l1: 230, voltage_l2: 231, voltage_l3: 229, current_power: 1500, energy_used: 100, ...extra });
const sendReading = (meter_id, extra) => call("POST", "/api/meter", { body: reading(meter_id, extra), headers: METER_HEADERS });
const register = (email, meter_id) => call("POST", "/api/auth/register", { body: { fullName: "Test " + email, email, password: "a-long-password-1", meter_id } });

async function approvedCustomer(email, meter_id) {
  await sendReading(meter_id);                                   // the meter has to exist first
  assert.equal((await register(email, meter_id)).status, 201);
  const pending = (await call("GET", "/api/admin/customers?status=pending", { token: adminToken })).json.find(u => u.email === email);
  assert.equal((await call("PATCH", `/api/admin/customers/${pending.id}/review`, { token: adminToken, body: { status: "active", meter_id } })).status, 200);
  const r = await login(email, "a-long-password-1");
  assert.equal(r.status, 200);
  return { token: r.json.token, id: pending.id };
}

before(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await Promise.all([User.init(), Meter.init(), MeterReading.init(), Bill.init(), Fault.init()]);
  await seedDefaults();
  await User.create({ fullName: "Admin", email: "admin@test.local", passwordHash: await bcrypt.hash("admin-password-123", 4), role: "admin", status: "active" });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  adminToken = (await login("admin@test.local", "admin-password-123")).json.token;
});

after(async () => {
  await new Promise(r => server.close(r));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("tiered tariff maths", () => {
  const tiers = [{ name: "1", from: 0, to: 100, rate: 10, active: true }, { name: "2", from: 100, to: 300, rate: 15, active: true }, { name: "3", from: 300, to: null, rate: 20, active: true }];
  assert.equal(applyTariffs(50, tiers, 100, 0).total, 600);                  // 50 x 10 + 100 supply
  assert.equal(applyTariffs(250, tiers, 100, 0).energyCharge, 1000 + 2250);  // 100 x 10 + 150 x 15
  assert.equal(applyTariffs(400, tiers, 0, 0).energyCharge, 1000 + 3000 + 2000);
  assert.equal(applyTariffs(100, tiers, 100, 10).total, 1210);               // (1000 + 100) + 10% tax
  assert.equal(applyTariffs(-5, tiers, 0, 0).total, 0);
});

test("fault rules: a dead phase is a phase failure only, and is left out of the imbalance check", () => {
  const s = { voltageLow: 180, voltageHigh: 260, phaseFailureVoltage: 50, phaseImbalance: 30 };
  const types = m => faultConditions(m, s).map(f => `${f.type}:${f.phase}`);
  assert.deepEqual(types({ voltage_l1: 230, voltage_l2: 231, voltage_l3: 229 }), []);
  assert.deepEqual(types({ voltage_l1: 230, voltage_l2: 0, voltage_l3: 230 }), ["Phase failure:L2"]);
  assert.deepEqual(types({ voltage_l1: 270, voltage_l2: 230, voltage_l3: 230 }), ["Overvoltage:L1", "Phase imbalance:ALL"]);
  assert.deepEqual(types({ voltage_l1: 170, voltage_l2: 230, voltage_l3: 230 }), ["Undervoltage:L1", "Phase imbalance:ALL"]);   // 60 V apart > 30 V limit
});

test("meter payload validation rejects junk and injection attempts", () => {
  assert.throws(() => parseMeterPayload({ ...reading("M1"), meter_id: { $ne: null } }));       // NoSQL injection
  assert.throws(() => parseMeterPayload(reading("M1", { voltage_l1: -5 })));
  assert.throws(() => parseMeterPayload(reading("M1", { energy_used: "abc" })));
  assert.throws(() => parseMeterPayload(reading("M1", { current_power: Infinity })));
  assert.throws(() => parseMeterPayload([]));
  const ok = parseMeterPayload({ ...reading("M-1.a:2"), voltage_l1: "230.5", isAdmin: true });
  assert.equal(ok.voltage_l1, 230.5);
  assert.equal(ok.isAdmin, undefined);                                                          // unknown fields are dropped
});

test("health check works and the JWT secret is not a hardcoded default", async () => {
  assert.equal((await call("GET", "/api/health")).json.ok, true);
  const forged = jwt.sign({ sub: "000000000000000000000000", role: "admin" }, "zenplug-local-development-secret-change-before-deployment");
  assert.equal((await call("GET", "/api/readings", { token: forged })).status, 401);          // the old public default secret no longer works
});

test("meter ingestion needs the shared token and stores readings", async () => {
  assert.equal((await call("POST", "/api/meter", { body: reading("ING-1") })).status, 401);
  assert.equal((await call("POST", "/api/meter", { body: reading("ING-1"), headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await sendReading("ING-1")).status, 201);
  assert.equal((await sendReading("ING-1", { voltage_l1: 99999 })).status, 400);
  assert.equal(await MeterReading.countDocuments({ meter_id: "ING-1" }), 1);
});

test("a NoSQL-injection body cannot overwrite another meter", async () => {
  await sendReading("VICTIM-1", { energy_used: 500 });
  const r = await call("POST", "/api/meter", { body: { ...reading("x"), meter_id: { $ne: "nothing" }, energy_used: 1 }, headers: METER_HEADERS });
  assert.equal(r.status, 400);
  assert.equal((await Meter.findOne({ meter_id: "VICTIM-1" })).energy_used, 500);
});

test("enrollment: pending customers cannot sign in or see data until approved", async () => {
  await sendReading("ENR-1");
  assert.equal((await register("pending@test.local", "NO-SUCH-METER")).status, 400);
  assert.equal((await register("pending@test.local", "ENR-1")).status, 201);
  assert.equal((await register("pending@test.local", "ENR-1")).status, 409);                    // same email twice
  assert.equal((await login("pending@test.local", "a-long-password-1")).status, 403);
  assert.equal((await login("pending@test.local", "wrong-password")).status, 401);
  const pending = (await call("GET", "/api/admin/customers?status=pending", { token: adminToken })).json.find(u => u.email === "pending@test.local");
  assert.equal(pending.status, "pending");
  await call("PATCH", `/api/admin/customers/${pending.id}/review`, { token: adminToken, body: { status: "active", meter_id: "ENR-1" } });
  const r = await login("pending@test.local", "a-long-password-1");
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/api/customer/meter", { token: r.json.token })).json.meter_id, "ENR-1");
});

test("one meter cannot be approved for two customers", async () => {
  await approvedCustomer("first@test.local", "SHARE-1");
  assert.equal((await register("second@test.local", "SHARE-1")).status, 201);
  const second = (await call("GET", "/api/admin/customers?status=pending", { token: adminToken })).json.find(u => u.email === "second@test.local");
  const r = await call("PATCH", `/api/admin/customers/${second.id}/review`, { token: adminToken, body: { status: "active", meter_id: "SHARE-1" } });
  assert.equal(r.status, 409);
  assert.equal((await login("second@test.local", "a-long-password-1")).status, 403);
});

test("customers only see their own meter and cannot use admin routes", async () => {
  const a = await approvedCustomer("owner-a@test.local", "OWN-A");
  const b = await approvedCustomer("owner-b@test.local", "OWN-B");
  await sendReading("OWN-B", { energy_used: 777 });
  const seenByA = (await call("GET", "/api/customer/meter", { token: a.token })).json;
  assert.equal(seenByA.meter_id, "OWN-A");
  const seriesA = (await call("GET", "/api/customer/readings?range=1h", { token: a.token })).json;
  assert.ok(seriesA.every(r => r.energy_used !== 777));
  for (const path of ["/api/admin/customers", "/api/readings", "/api/bills", "/api/settings", "/api/audit", "/api/meter"]) {
    assert.equal((await call("GET", path, { token: a.token })).status, 403, path);
    assert.equal((await call("GET", path)).status, 401, path);
  }
  assert.equal((await call("GET", "/api/customer/meter", { token: adminToken })).status, 403);
  assert.ok(b.token);
});

test("faults open from bad readings and clear by themselves; silent meters are flagged offline", async () => {
  await sendReading("FLT-1", { voltage_l1: 275 });
  let open = (await call("GET", "/api/faults?status=active&meter_id=FLT-1", { token: adminToken })).json.map(f => f.type);
  assert.ok(open.includes("Overvoltage"));
  await sendReading("FLT-1");
  open = (await call("GET", "/api/faults?status=active&meter_id=FLT-1", { token: adminToken })).json;
  assert.deepEqual(open, []);

  await Meter.updateOne({ meter_id: "FLT-1" }, { lastReadingAt: new Date(Date.now() - 3600 * 1000) });
  await runPeriodicChecks();
  open = (await call("GET", "/api/faults?status=active&meter_id=FLT-1", { token: adminToken })).json.map(f => f.type);
  assert.deepEqual(open, ["Meter offline"]);
  await sendReading("FLT-1");
  assert.deepEqual((await call("GET", "/api/faults?status=active&meter_id=FLT-1", { token: adminToken })).json, []);

  await call("POST", "/api/admin/meters", { token: adminToken, body: { meter_id: "NEVER-1" } });
  await runPeriodicChecks();
  assert.equal((await call("GET", "/api/faults?meter_id=NEVER-1", { token: adminToken })).json.length, 0);   // never reported = just awaiting
});

test("bills use the meter's counter, never overwrite a paid bill, and customers see only theirs", async () => {
  const c = await approvedCustomer("billing@test.local", "BILL-1");
  const d = new Date(Date.now() + 330 * 60000 - 40 * 86400000);                 // a date in a month that has finished (Sri Lanka time)
  const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1;
  const monthStart = new Date(Date.UTC(year, month - 1, 1) - 330 * 60000);
  const at = days => new Date(monthStart.getTime() + days * 86400000);
  await MeterReading.create([{ ...reading("BILL-1", { energy_used: 100 }), timestamp: at(1) }, { ...reading("BILL-1", { energy_used: 160 }), timestamp: at(10) }]);

  const gen = await call("POST", "/api/bills/generate", { token: adminToken, body: { year, month } });
  assert.equal(gen.status, 200);
  const bill = (await call("GET", "/api/bills?meter_id=BILL-1", { token: adminToken })).json[0];
  assert.equal(bill.units, 60);
  assert.equal(bill.total, 700);                                                // 60 x 10 + 100 supply (default tiers)
  assert.equal((await call("GET", "/api/customer/bills", { token: c.token })).json.length, 1);

  await call("PATCH", `/api/bills/${bill._id}/status`, { token: adminToken, body: { status: "paid" } });
  await call("PUT", "/api/settings", { token: adminToken, body: { supplyCharge: 500 } });
  await call("POST", "/api/bills/generate", { token: adminToken, body: { year, month } });
  const after = (await call("GET", "/api/bills?meter_id=BILL-1", { token: adminToken })).json[0];
  assert.equal(after.status, "paid");
  assert.equal(after.total, 700);                                               // regenerating did not touch the paid bill
  await call("PUT", "/api/settings", { token: adminToken, body: { supplyCharge: 100 } });
  assert.equal((await call("POST", "/api/bills/generate", { token: adminToken, body: { year: 1999, month: 1 } })).status, 400);
});

test("customer chart endpoints return bucketed data", async () => {
  const c = await approvedCustomer("charts@test.local", "CHT-1");
  await sendReading("CHT-1", { energy_used: 110 });                             // approvedCustomer() already sent a reading of 100 kWh
  await sendReading("CHT-1", { energy_used: 112 });
  const series = (await call("GET", "/api/customer/readings?range=24h", { token: c.token })).json;
  assert.ok(series.length >= 1 && series[0].timestamp && series[0].voltage_l1 > 0);
  const daily = (await call("GET", "/api/customer/daily?days=7", { token: c.token })).json;
  assert.equal(daily.at(-1).kwh, 12);                                           // the counter went 100 -> 112 today
  const est = (await call("GET", "/api/customer/billing-estimate", { token: c.token })).json;
  assert.equal(est.estimate.units, 12);
});

test("admin can delete a customer account, which signs them out immediately", async () => {
  const c = await approvedCustomer("delete-me@test.local", "DEL-1");
  assert.equal((await call("DELETE", `/api/admin/customers/${c.id}`, { token: adminToken })).status, 200);
  assert.equal((await call("GET", "/api/customer/meter", { token: c.token })).status, 401);
  assert.equal((await login("delete-me@test.local", "a-long-password-1")).status, 401);
  assert.equal((await call("DELETE", "/api/admin/customers/not-an-id", { token: adminToken })).status, 404);
  assert.ok(await Meter.exists({ meter_id: "DEL-1" }));                         // the meter itself stays
});

test("tariff tiers are validated", async () => {
  assert.equal((await call("POST", "/api/tariffs", { token: adminToken, body: { name: "bad", from: 100, to: 50, rate: 1 } })).status, 400);
  assert.equal((await call("POST", "/api/tariffs", { token: adminToken, body: { name: "bad", from: 0, rate: -1 } })).status, 400);
  assert.equal((await call("POST", "/api/tariffs", { token: adminToken, body: { name: "", from: 0, rate: 1 } })).status, 400);
  const ok = await call("POST", "/api/tariffs", { token: adminToken, body: { name: "extra", from: 1000, to: "", rate: 30, active: false } });
  assert.equal(ok.status, 201);
  assert.equal((await call("DELETE", `/api/tariffs/${ok.json._id}`, { token: adminToken })).status, 200);
});

test("query-string injection in filters is ignored", async () => {
  const r = await call("GET", "/api/faults?status[$ne]=zzz&meter_id[$ne]=zzz", { token: adminToken });
  assert.equal(r.status, 200);                                                  // treated as "no filter", not as a MongoDB operator
});

test("repeated wrong passwords are rate limited", async () => {
  let limited = false;
  for (let i = 0; i < 15 && !limited; i++) limited = (await login("admin@test.local", "wrong-password-" + i)).status === 429;
  assert.ok(limited, "expected a 429 after repeated failures");
});
