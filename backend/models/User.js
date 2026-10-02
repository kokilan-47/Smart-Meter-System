const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["admin", "customer"], required: true },
  status: { type: String, enum: ["pending", "active", "rejected"], required: true },
  meter_id: { type: String, default: "" },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: String, default: "" }
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
