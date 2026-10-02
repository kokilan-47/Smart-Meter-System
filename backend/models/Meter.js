const mongoose = require("mongoose");

const meterSchema = new mongoose.Schema({
  meter_id: { type: String, required: true, unique: true },
  voltage_l1: { type: Number, required: true },
  voltage_l2: { type: Number, required: true },
  voltage_l3: { type: Number, required: true },
  current_power: { type: Number, required: true },
  energy_used: { type: Number, required: true },
  lastReadingAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model("Meter", meterSchema);
