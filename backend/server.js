/* ---------------------------------------------------------------------------
   Zenplug API - Express + MongoDB.
   Sections: setup, helpers, public/auth, customer, meter ingestion, admin.
   Every route after the line `app.use("/api", authenticate, requireAdmin)` needs an admin login.
--------------------------------------------------------------------------- */
const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Meter = require("./models/Meter");
const MeterReading = require("./models/MeterReading");
const Bill = require("./models/Bill");
const Fault = require("./models/Fault");
const Setting = require("./models/Setting");
const Tariff = require("./models/Tariff");
const AuditLog = require("./models/AuditLog");
const User = require("./models/User");

/* ------------------------------- setup ------------------------------------ */

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const DB = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/smart_electric_meter";
const NODE_ENV = process.env.NODE_ENV || "development";
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(origin => origin.trim()).filter(Boolean);
const METER_INGEST_TOKEN = process.env.METER_INGEST_TOKEN || "";
// Sri Lanka is UTC+5:30 = 330 minutes. Billing months and "daily" totals use this offset.
const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES ?? 330);
const TZ_OFFSET_MS = TZ_OFFSET_MINUTES * 60000;
const TZ_STRING = `${TZ_OFFSET_MINUTES < 0 ? "-" : "+"}${String(Math.floor(Math.abs(TZ_OFFSET_MINUTES) / 60)).padStart(2, "0")}${String(Math.abs(TZ_OFFSET_MINUTES) % 60).padStart(2, "0")}`;

if (NODE_ENV === "production" && (!process.env.MONGODB_URI || !process.env.JWT_SECRET || !CORS_ORIGINS.length || !METER_INGEST_TOKEN)) {
  throw new Error("Production requires MONGODB_URI, JWT_SECRET, CORS_ORIGINS, and METER_INGEST_TOKEN environment variables.");
}

// The secret that signs login tokens. There is deliberately NO default written in the code: anyone who
// knew a default could forge an administrator login. Without JWT_SECRET we make a random one per run.
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString("hex");
  if (NODE_ENV !== "test") console.warn("JWT_SECRET is not set - using a random one for this run, so everyone is signed out when the server restarts. Set JWT_SECRET (see backend/.env.example).");
}

app.disable("x-powered-by");
if (NODE_ENV === "production") app.set("trust proxy", 1);   // behind Render's proxy: use the real client IP for rate limits
app.use(NODE_ENV === "production" ? cors({ origin(origin, callback) {
  if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
  callback(new Error("Origin is not allowed by CORS."));
} }) : cors());
app.use(express.json({ limit: "100kb" }));

// Slow down password guessing and registration spam. Only failed logins count against the limit.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_ATTEMPTS || 10), skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: "Too many failed sign-in attempts. Try again in 15 minutes." } });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.REGISTER_ATTEMPTS || 10), standardHeaders: true, legacyHeaders: false, message: { error: "Too many registration attempts. Try again later." } });

const DEFAULT_SETTINGS = {
  voltageLow: 180,
  voltageHigh: 260,
  phaseFailureVoltage: 50,
  phaseImbalance: 30,
  offlineMinutes: 15,
  baseRate: 10,
  supplyCharge: 100,
  taxRate: 0
};

/* ------------------------------- helpers ---------------------------------- */

const str = value => (typeof value === "string" ? value.trim() : "");   // never trust that a request field is a string
const METER_ID_PATTERN = /^[\w.:-]{1,100}$/;

async function seedDefaults() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await Setting.updateOne({ key }, { $setOnInsert: { key, value } }, { upsert: true });
  }
  const count = await Tariff.countDocuments();
  if (!count) {
    // Illustrative starter tiers - the administrator edits them under Settings > Tariff tiers.
    await Tariff.insertMany([
      { name: "Tier 1", from: 0, to: 100, rate: DEFAULT_SETTINGS.baseRate, active: true },
      { name: "Tier 2", from: 100, to: 300, rate: DEFAULT_SETTINGS.baseRate * 1.5, active: true },
      { name: "Tier 3", from: 300, to: null, rate: DEFAULT_SETTINGS.baseRate * 2, active: true }
    ]);
  }
}

async function getSettings() {
  const docs = await Setting.find().lean();
  const out = { ...DEFAULT_SETTINGS };
  docs.forEach(d => { out[d.key] = d.value; });
  return out;
}

async function audit(action, entity, entityId = "", details = {}, req = null) {
  try {
    await AuditLog.create({
      actor: req?.user?.email || str(req?.body?.email) || "system",
      action,
      entity,
      entityId: String(entityId || ""),
      details,
      ip: req?.ip || "local"
    });
  } catch (e) {
    console.error("Audit log error:", e.message);
  }
}

async function authenticate(req, res, next) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    const account = await User.findById(claims.sub);
    if (!account || account.status !== "active" || account.role !== claims.role) return res.status(401).json({ error: "This account is no longer active." });
    req.user = { sub: String(account._id), email: account.email, role: account.role };
    next();
  } catch (_) { res.status(401).json({ error: "Your session has expired. Please sign in again." }); }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
  next();
}

function requireCustomer(req, res, next) {
  if (req.user?.role !== "customer") return res.status(403).json({ error: "Customer access required." });
  next();
}

function publicUser(user) {
  return { id: user._id, fullName: user.fullName, email: user.email, role: user.role, status: user.status, meter_id: user.meter_id || "", createdAt: user.createdAt };
}

// Loads the signed-in customer and checks they have a meter. Used by every /api/customer/* route.
async function customerWithMeter(req, res, next) {
  const user = await User.findById(req.user.sub);
  if (!user?.meter_id) return res.status(404).json({ error: "No meter is linked to this account." });
  req.meter_id = user.meter_id;
  next();
}

// Meter readings are posted by hardware, so validate every field and ignore anything unexpected.
function parseMeterPayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object.");
  const meter_id = typeof body.meter_id === "string" ? body.meter_id.trim() : "";
  if (!METER_ID_PATTERN.test(meter_id)) throw new Error("meter_id must be 1-100 characters: letters, digits, . _ : -");
  const num = (name, max) => {
    const raw = typeof body[name] === "string" && body[name].trim() !== "" ? Number(body[name]) : body[name];
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > max) throw new Error(`${name} must be a number between 0 and ${max}.`);
    return raw;
  };
  return {
    meter_id,
    voltage_l1: num("voltage_l1", 1000), voltage_l2: num("voltage_l2", 1000), voltage_l3: num("voltage_l3", 1000),
    current_power: num("current_power", 1e7),   // watts
    energy_used: num("energy_used", 1e9)        // cumulative kWh
  };
}

function meterAuthorized(req) {
  if (!METER_INGEST_TOKEN) return true;          // not configured: development only (production requires it)
  const given = Buffer.from(req.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${METER_INGEST_TOKEN}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function faultConditions(meter, settings) {
  const out = [];
  const phases = [
    ["L1", Number(meter.voltage_l1)],
    ["L2", Number(meter.voltage_l2)],
    ["L3", Number(meter.voltage_l3)]
  ];
  for (const [phase, value] of phases) {
    if (value < Number(settings.phaseFailureVoltage)) out.push({ type: "Phase failure", phase, value, limit: settings.phaseFailureVoltage });
    else if (value > Number(settings.voltageHigh)) out.push({ type: "Overvoltage", phase, value, limit: settings.voltageHigh });
    else if (value < Number(settings.voltageLow)) out.push({ type: "Undervoltage", phase, value, limit: settings.voltageLow });
  }
  // imbalance is only meaningful between phases that still have supply
  const live = phases.map(x => x[1]).filter(v => v >= Number(settings.phaseFailureVoltage));
  if (live.length >= 2 && Math.max(...live) - Math.min(...live) > Number(settings.phaseImbalance)) {
    out.push({ type: "Phase imbalance", phase: "ALL", value: Math.max(...live) - Math.min(...live), limit: settings.phaseImbalance });
  }
  return out;
}

// Opens faults that are now present and closes faults whose condition has cleared.
async function syncFaultsForMeter(meter, settings) {
  const conditions = faultConditions(meter, settings);
  const now = new Date();
  const activeKeys = new Set(conditions.map(f => `${f.type}|${f.phase}`));

  for (const f of conditions) {
    await Fault.findOneAndUpdate(
      { meter_id: meter.meter_id, type: f.type, phase: f.phase, status: "active" },
      { $set: { value: f.value, limit: f.limit, lastSeen: now }, $setOnInsert: { firstSeen: now } },
      { upsert: true, new: true }
    );
  }

  const active = await Fault.find({ meter_id: meter.meter_id, status: "active" });
  for (const f of active) {
    // any reading at all means the meter is back, so "Meter offline" clears here too
    if (f.type === "Meter offline" || !activeKeys.has(`${f.type}|${f.phase}`)) {
      f.status = "resolved";
      f.resolvedAt = now;
      f.resolutionNote = f.type === "Meter offline" ? "Meter reporting resumed" : "Condition cleared by incoming meter reading";
      await f.save();
    }
  }
  return conditions;
}

// Runs every minute: flag meters that stopped reporting, and mark unpaid bills past their due date.
async function runPeriodicChecks() {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - Number(settings.offlineMinutes) * 60000);
  const reportedBefore = await Meter.find({ lastReadingAt: { $ne: null } }).lean();   // a meter that never reported is just "awaiting first reading"
  for (const meter of reportedBefore) {
    if (new Date(meter.lastReadingAt) < cutoff) {
      const minutes = Math.round((Date.now() - new Date(meter.lastReadingAt).getTime()) / 60000);
      await Fault.findOneAndUpdate(
        { meter_id: meter.meter_id, type: "Meter offline", phase: "ALL", status: "active" },
        { $set: { value: `${minutes} min`, limit: `${settings.offlineMinutes} min`, lastSeen: new Date() }, $setOnInsert: { firstSeen: new Date() } },
        { upsert: true, new: true }
      );
    }
  }
  await Bill.updateMany({ status: "issued", dueDate: { $lt: new Date() } }, { $set: { status: "overdue" } });
}

/* ------------------------- billing and time maths ------------------------- */

function monthRange(year, month) {   // [start, end) of a month in local (Sri Lankan) time
  return { start: new Date(Date.UTC(year, month - 1, 1) - TZ_OFFSET_MS), end: new Date(Date.UTC(year, month, 1) - TZ_OFFSET_MS) };
}
function localMonthNow() {
  const d = new Date(Date.now() + TZ_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
const periodName = (year, month) => `${year}-${String(month).padStart(2, "0")}`;

// kWh used in a period: the meter's cumulative counter at the end minus at the start.
// Uses only two indexed look-ups, so it stays fast however many readings are stored.
async function periodUsage(meter_id, start, end) {
  const inRange = { meter_id, timestamp: { $gte: start, $lt: end } };
  const last = await MeterReading.findOne(inRange).sort({ timestamp: -1 }).lean();
  if (!last) return null;
  const before = await MeterReading.findOne({ meter_id, timestamp: { $lt: start } }).sort({ timestamp: -1 }).lean();
  const first = before || await MeterReading.findOne(inRange).sort({ timestamp: 1 }).lean();
  const opening = Number(first.energy_used || 0), closing = Number(last.energy_used || 0);
  return { opening, closing, units: Math.max(0, closing - opening) };
}

function applyTariffs(units, tariffs, supplyCharge, taxRate) {
  let remaining = Math.max(0, Number(units) || 0);
  let energyCharge = 0;
  const sorted = tariffs.filter(t => t.active).sort((a, b) => a.from - b.from);
  for (const t of sorted) {
    if (remaining <= 0) break;
    const width = t.to == null ? remaining : Math.min(remaining, Math.max(0, t.to - t.from));
    if (width > 0) {
      energyCharge += width * Number(t.rate);
      remaining -= width;
    }
  }
  const subtotal = energyCharge + Number(supplyCharge || 0);
  const tax = subtotal * (Number(taxRate || 0) / 100);
  return { energyCharge, supplyCharge: Number(supplyCharge || 0), tax, total: subtotal + tax };
}

async function generateBillForMeter(meter, year, month, tariffs, settings) {
  const { start, end } = monthRange(year, month);
  const usage = await periodUsage(meter.meter_id, start, end);
  if (!usage) return null;
  const period = periodName(year, month);
  const existing = await Bill.findOne({ meter_id: meter.meter_id, period });
  if (existing && !["issued", "overdue"].includes(existing.status)) return existing;   // never rewrite a paid or cancelled bill
  const charge = applyTariffs(usage.units, tariffs, settings.supplyCharge, settings.taxRate);
  const dueDate = new Date(Date.UTC(year, month, 15) - TZ_OFFSET_MS);
  return Bill.findOneAndUpdate(
    { meter_id: meter.meter_id, period },
    { $set: { periodStart: start, periodEnd: new Date(end.getTime() - 1), openingEnergy: usage.opening, closingEnergy: usage.closing, units: usage.units, ...charge, dueDate, status: existing?.status || "issued", generatedAt: new Date() } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// Charts: readings averaged into time buckets, so a 30-day chart never needs millions of rows.
const RANGES = { "1h": [3600, 30], "24h": [86400, 300], "7d": [604800, 1800], "30d": [2592000, 7200] };   // [span, bucket] in seconds
async function readingSeries(meter_id, range) {
  const [span, bucket] = RANGES[range] || RANGES["24h"];
  const ms = bucket * 1000, t = { $toLong: "$timestamp" };
  return MeterReading.aggregate([
    { $match: { meter_id, timestamp: { $gte: new Date(Date.now() - span * 1000) } } },
    { $group: { _id: { $subtract: [t, { $mod: [t, ms] }] }, voltage_l1: { $avg: "$voltage_l1" }, voltage_l2: { $avg: "$voltage_l2" }, voltage_l3: { $avg: "$voltage_l3" }, current_power: { $avg: "$current_power" }, energy_used: { $max: "$energy_used" } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, timestamp: { $toDate: "$_id" }, voltage_l1: 1, voltage_l2: 1, voltage_l3: 1, current_power: 1, energy_used: 1 } }
  ]);
}

// kWh per local day, from the meter's cumulative counter (highest minus lowest value that day).
async function dailyUsage(meter_id, days) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await MeterReading.aggregate([
    { $match: { meter_id, timestamp: { $gte: since } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: TZ_STRING } }, low: { $min: "$energy_used" }, high: { $max: "$energy_used" } } },
    { $sort: { _id: 1 } }
  ]);
  return rows.map(r => ({ date: r._id, kwh: Math.round(Math.max(0, r.high - r.low) * 100) / 100 }));
}

function tariffFromBody(body) {
  const name = str(body.name);
  const from = Number(body.from), rate = Number(body.rate);
  const to = body.to === "" || body.to == null ? null : Number(body.to);
  if (!name || name.length > 60) throw new Error("Enter a tier name (up to 60 characters).");
  if (!Number.isFinite(from) || from < 0 || !Number.isFinite(rate) || rate < 0) throw new Error("From and rate must be zero or more.");
  if (to !== null && (!Number.isFinite(to) || to <= from)) throw new Error("'To' must be larger than 'From' (or blank for unlimited).");
  return { name, from, to, rate, active: body.active !== false };
}

/* ------------------------- public routes and sign-in ---------------------- */

app.get("/", (req, res) => res.json({ service: "Zenplug API", health: "/api/health" }));
app.get("/api/health", async (req, res) => {
  const database = mongoose.connection.readyState === 1;
  res.status(database ? 200 : 503).json({ ok: database, database });
});

// Customers apply here. Their account stays "pending" - and has no access to any data - until an admin approves it.
app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const fullName = str(req.body.fullName);
    const email = str(req.body.email).toLowerCase();
    const meter_id = str(req.body.meter_id);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (fullName.length < 2 || fullName.length > 120) return res.status(400).json({ error: "Enter your full name." });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 10) return res.status(400).json({ error: "Use a password with at least 10 characters." });
    if (!meter_id || !await Meter.exists({ meter_id })) return res.status(400).json({ error: "Enter a meter ID registered with this utility." });
    if (await User.exists({ email })) return res.status(409).json({ error: "An account or application already uses this email." });
    const user = await User.create({ fullName, email, meter_id, passwordHash: await bcrypt.hash(password, 12), role: "customer", status: "pending" });
    await audit("CUSTOMER_APPLICATION_SUBMITTED", "customer", user._id, { email, meter_id }, req);
    res.status(201).json({ message: "Your request was sent for administrator approval." });
  } catch (error) { res.status(400).json({ error: error.code === 11000 ? "An account or application already uses this email." : error.message }); }
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const email = str(req.body.email).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = await User.findOne({ email }).select("+passwordHash");
    if (!user || !await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: "Email or password is incorrect." });
    if (user.status === "pending") return res.status(403).json({ error: "Your registration is awaiting administrator approval." });
    if (user.status !== "active") return res.status(403).json({ error: "This account is not active. Contact the utility administrator." });
    const token = jwt.sign({ sub: String(user._id), email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "8h" });
    res.json({ token, user: publicUser(user) });
  } catch (error) { res.status(500).json({ error: "Sign-in failed." }); }
});

app.get("/api/auth/me", authenticate, async (req, res) => {
  const user = await User.findById(req.user.sub);
  if (!user || user.status !== "active") return res.status(401).json({ error: "Account is no longer active." });
  res.json(publicUser(user));
});

/* ----------------------- customer routes (own meter only) ----------------- */

const customerOnly = [authenticate, requireCustomer, customerWithMeter];

app.get("/api/customer/meter", customerOnly, async (req, res) => {
  const meter = await Meter.findOne({ meter_id: req.meter_id });
  if (!meter) return res.status(404).json({ error: "The linked meter has no readings yet." });
  const hasReading = meter.lastReadingAt || await MeterReading.exists({ meter_id: meter.meter_id });
  if (!hasReading) return res.status(409).json({ error: "Your meter is registered and linked, but is waiting for its first reading." });
  res.json(meter);
});

// ?range=1h|24h|7d|30d  ->  averaged readings, oldest first
app.get("/api/customer/readings", customerOnly, async (req, res) => res.json(await readingSeries(req.meter_id, str(req.query.range))));

// ?days=30  ->  [{ date, kwh }]
app.get("/api/customer/daily", customerOnly, async (req, res) => {
  res.json(await dailyUsage(req.meter_id, Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 90)));
});

app.get("/api/customer/bills", customerOnly, async (req, res) => res.json(await Bill.find({ meter_id: req.meter_id }).sort({ period: -1, generatedAt: -1 })));

app.get("/api/customer/billing-estimate", customerOnly, async (req, res) => {
  const { year, month } = localMonthNow();
  const { start, end } = monthRange(year, month);
  const period = periodName(year, month);
  const usage = await periodUsage(req.meter_id, start, end);
  if (!usage) return res.json({ period, estimate: null });
  const settings = await getSettings();
  const tariffs = await Tariff.find({ active: true }).lean();
  res.json({ period, estimate: { units: usage.units, ...applyTariffs(usage.units, tariffs, settings.supplyCharge, settings.taxRate) } });
});

app.get("/api/customer/faults", customerOnly, async (req, res) => res.json(await Fault.find({ meter_id: req.meter_id }).sort({ status: 1, lastSeen: -1 }).limit(200)));

/* ------------------------------ meter ingestion --------------------------- */

// The ESP32 / meter hardware posts here. See docs/API.md for the exact JSON.
app.post("/api/meter", async (req, res) => {
  if (!meterAuthorized(req)) return res.status(401).json({ error: "Meter device authentication failed." });
  try {
    const data = parseMeterPayload(req.body);
    const now = new Date();
    const savedMeter = await Meter.findOneAndUpdate(
      { meter_id: data.meter_id },
      { $set: { ...data, lastReadingAt: now } },
      { new: true, upsert: true, runValidators: true }
    );
    const reading = await MeterReading.create({ ...data, timestamp: now });
    await syncFaultsForMeter(savedMeter, await getSettings());
    res.status(201).json({ meter: savedMeter, reading });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

/* ------------------------- everything below: admin only ------------------- */

app.use("/api", authenticate, requireAdmin);

app.get("/api/meter", async (req, res) => res.json(await Meter.find().sort({ meter_id: 1 })));

app.get("/api/readings", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 2000);
  const filter = str(req.query.meter_id) ? { meter_id: str(req.query.meter_id) } : {};
  res.json(await MeterReading.find(filter).sort({ timestamp: -1 }).limit(limit));
});

app.post("/api/admin/meters", async (req, res) => {
  try {
    const meter_id = str(req.body.meter_id);
    if (!METER_ID_PATTERN.test(meter_id)) return res.status(400).json({ error: "Meter ID must be 1-100 characters: letters, digits, . _ : -" });
    if (await Meter.exists({ meter_id })) return res.status(409).json({ error: "That meter ID is already registered." });
    const meter = await Meter.create({ meter_id, voltage_l1: 0, voltage_l2: 0, voltage_l3: 0, current_power: 0, energy_used: 0, lastReadingAt: null });
    await audit("REGISTER_METER", "meter", meter.meter_id, { status: "awaiting_first_reading" }, req);
    res.status(201).json(meter);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get("/api/admin/customers", async (req, res) => {
  const status = str(req.query.status);
  const filter = status ? { status } : {};
  res.json((await User.find({ ...filter, role: "customer" }).sort({ createdAt: -1 })).map(publicUser));
});

app.patch("/api/admin/customers/:id/review", async (req, res) => {
  try {
    const status = req.body.status;
    if (!["active", "rejected"].includes(status)) return res.status(400).json({ error: "Choose approve or reject." });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Customer application not found." });
    const user = await User.findOne({ _id: req.params.id, role: "customer" });
    if (!user) return res.status(404).json({ error: "Customer application not found." });
    const meter_id = str(req.body.meter_id) || user.meter_id || "";
    if (status === "active") {
      if (!meter_id || !await Meter.exists({ meter_id })) return res.status(400).json({ error: "Choose a meter currently registered in the system." });
      // one meter = one household: stops two customers seeing the same meter's data
      if (await User.exists({ meter_id, role: "customer", status: "active", _id: { $ne: user._id } })) return res.status(409).json({ error: "That meter is already linked to another approved customer." });
    }
    user.status = status;
    user.meter_id = meter_id;
    user.reviewedAt = new Date();
    user.reviewedBy = req.user.email;
    await user.save();
    await audit(status === "active" ? "APPROVE_CUSTOMER" : "REJECT_CUSTOMER", "customer", user._id, { email: user.email, meter_id }, req);
    res.json(publicUser(user));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

// Removes a customer account (their meter, readings and bills stay in the system).
app.delete("/api/admin/customers/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Customer not found." });
  const user = await User.findOne({ _id: req.params.id, role: "customer" });
  if (!user) return res.status(404).json({ error: "Customer not found." });
  await user.deleteOne();
  await audit("DELETE_CUSTOMER", "customer", user._id, { email: user.email, meter_id: user.meter_id }, req);
  res.json({ ok: true });
});

// Settings
app.get("/api/settings", async (req, res) => res.json(await getSettings()));
app.put("/api/settings", async (req, res) => {
  try {
    const changed = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (req.body[key] !== undefined) {
        const value = Number(req.body[key]);
        if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: `Invalid setting: ${key}` });
        await Setting.findOneAndUpdate({ key }, { key, value }, { upsert: true, new: true });
        changed[key] = value;
      }
    }
    await audit("UPDATE_SETTINGS", "settings", "global", changed, req);
    res.json(await getSettings());
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Tariffs
app.get("/api/tariffs", async (req, res) => res.json(await Tariff.find().sort({ from: 1 })));
app.post("/api/tariffs", async (req, res) => {
  try {
    const tariff = await Tariff.create(tariffFromBody(req.body));
    await audit("CREATE_TARIFF", "tariff", tariff._id, tariff.toObject(), req);
    res.status(201).json(tariff);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put("/api/tariffs/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Tariff not found" });
    const tariff = await Tariff.findByIdAndUpdate(req.params.id, tariffFromBody(req.body), { new: true, runValidators: true });
    if (!tariff) return res.status(404).json({ error: "Tariff not found" });
    await audit("UPDATE_TARIFF", "tariff", tariff._id, tariff.toObject(), req);
    res.json(tariff);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/tariffs/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Tariff not found" });
    const tariff = await Tariff.findByIdAndDelete(req.params.id);
    if (!tariff) return res.status(404).json({ error: "Tariff not found" });
    await audit("DELETE_TARIFF", "tariff", tariff._id, tariff.toObject(), req);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Faults (offline meters are flagged by the background check, not here)
app.get("/api/faults", async (req, res) => {
  const filter = {};
  if (str(req.query.status)) filter.status = str(req.query.status);
  if (str(req.query.meter_id)) filter.meter_id = str(req.query.meter_id);
  if (str(req.query.type)) filter.type = str(req.query.type);
  res.json(await Fault.find(filter).sort({ status: 1, lastSeen: -1 }).limit(500));
});
app.patch("/api/faults/:id/resolve", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Fault not found" });
    const fault = await Fault.findByIdAndUpdate(req.params.id, { status: "resolved", resolvedAt: new Date(), resolutionNote: str(req.body.note) || "Resolved by administrator" }, { new: true });
    if (!fault) return res.status(404).json({ error: "Fault not found" });
    await audit("RESOLVE_FAULT", "fault", fault._id, { meter_id: fault.meter_id, type: fault.type, note: fault.resolutionNote }, req);
    res.json(fault);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/faults/bulk-resolve", async (req, res) => {
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter(id => mongoose.isValidObjectId(id));
    const result = await Fault.updateMany({ _id: { $in: ids }, status: "active" }, { $set: { status: "resolved", resolvedAt: new Date(), resolutionNote: str(req.body.note) || "Bulk resolved by administrator" } });
    await audit("BULK_RESOLVE_FAULTS", "fault", "bulk", { count: result.modifiedCount }, req);
    res.json({ modified: result.modifiedCount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Billing
app.get("/api/bills", async (req, res) => {
  const filter = {};
  if (str(req.query.period)) filter.period = str(req.query.period);
  if (str(req.query.status)) filter.status = str(req.query.status);
  if (str(req.query.meter_id)) filter.meter_id = str(req.query.meter_id);
  res.json(await Bill.find(filter).sort({ period: -1, generatedAt: -1 }));
});
app.post("/api/bills/generate", async (req, res) => {
  try {
    const now = localMonthNow();
    const year = Number(req.body.year || now.year);
    const month = Number(req.body.month || now.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || year < 2020 || year > 2100 || month < 1 || month > 12) return res.status(400).json({ error: "Invalid billing period" });
    const tariffs = await Tariff.find({ active: true }).lean();
    const settings = await getSettings();
    const meters = await Meter.find().lean();
    const bills = [];
    for (const meter of meters) {
      const bill = await generateBillForMeter(meter, year, month, tariffs, settings);
      if (bill) bills.push(bill);
    }
    await audit("GENERATE_BILLS", "bill", periodName(year, month), { generated: bills.length }, req);
    res.json({ period: periodName(year, month), generated: bills.length, bills });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});
app.patch("/api/bills/:id/status", async (req, res) => {
  try {
    if (!["issued", "paid", "overdue", "cancelled"].includes(req.body.status)) return res.status(400).json({ error: "Invalid bill status" });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Bill not found" });
    const bill = await Bill.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    if (!bill) return res.status(404).json({ error: "Bill not found" });
    await audit("UPDATE_BILL_STATUS", "bill", bill._id, { status: bill.status }, req);
    res.json(bill);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Audit log of administrator actions
app.get("/api/audit", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  res.json(await AuditLog.find().sort({ createdAt: -1 }).limit(limit));
});

// Anything that goes wrong inside a route ends up here instead of crashing the server.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Body is not valid JSON." });
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

/* --------------------------------- start ---------------------------------- */

async function start() {
  await mongoose.connect(DB, { serverSelectionTimeoutMS: 8000 });
  console.log(`Connected to MongoDB (database: ${mongoose.connection.name})`);
  await MeterReading.init();                                   // make sure the indexes exist
  await seedDefaults();
  setInterval(() => runPeriodicChecks().catch(e => console.error("Periodic check failed:", e.message)), 60 * 1000).unref();
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}

if (require.main === module) {
  start().catch(error => {
    console.error("Could not start:", error.message);
    process.exit(1);
  });
}

module.exports = { app, start, seedDefaults, runPeriodicChecks, applyTariffs, faultConditions, parseMeterPayload };
