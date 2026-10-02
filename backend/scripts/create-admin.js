/* Creates the first administrator account.
   Usage:  npm run create-admin -- admin@example.com "a-password-of-at-least-12-characters"
   Public registration can only create customer applications, never administrators. */
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");

async function main() {
  const [emailArg, password] = process.argv.slice(2);
  const email = String(emailArg || "").trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email) || !password || password.length < 12) {
    throw new Error('Usage: npm run create-admin -- admin@example.com "password-of-at-least-12-characters"');
  }
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/smart_electric_meter");
  if (await User.findOne({ email })) throw new Error("An account with that email already exists.");
  const admin = await User.create({
    fullName: "System administrator",
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "admin",
    status: "active"
  });
  console.log(`Administrator created: ${admin.email}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
