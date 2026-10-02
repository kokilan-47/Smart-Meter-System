const mongoose = require("mongoose");

const billSchema = new mongoose.Schema({
  meter_id: { type: String, required: true },
  period: { type: String, required: true }, // YYYY-MM
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  openingEnergy: { type: Number, default: 0 },
  closingEnergy: { type: Number, default: 0 },
  units: { type: Number, default: 0 },
  energyCharge: { type: Number, default: 0 },
  supplyCharge: { type: Number, default: 0 },
  tax: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  status: { type: String, enum: ["issued", "paid", "overdue", "cancelled"], default: "issued" },
  dueDate: { type: Date },
  generatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

billSchema.index({ meter_id: 1, period: 1 }, { unique: true });
module.exports = mongoose.model("Bill", billSchema);
