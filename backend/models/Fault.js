const mongoose = require("mongoose");

const faultSchema = new mongoose.Schema({
  meter_id: { type: String, required: true },
  type: { type: String, required: true },
  phase: { type: String, default: "ALL" },
  value: { type: mongoose.Schema.Types.Mixed },
  limit: { type: mongoose.Schema.Types.Mixed },
  status: { type: String, enum: ["active", "resolved"], default: "active" },
  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now },
  resolvedAt: { type: Date },
  resolutionNote: { type: String, default: "" }
}, { timestamps: true });

faultSchema.index({ meter_id: 1, type: 1, phase: 1, status: 1 });
module.exports = mongoose.model("Fault", faultSchema);
