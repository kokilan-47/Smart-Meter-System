const mongoose = require("mongoose");

// One document per report sent by a meter.
const meterReadingSchema = new mongoose.Schema({
  meter_id: { type: String, required: true },
  voltage_l1: { type: Number, required: true },   // volts, phase L1
  voltage_l2: { type: Number, required: true },   // volts, phase L2
  voltage_l3: { type: Number, required: true },   // volts, phase L3
  current_power: { type: Number, required: true }, // watts (total)
  energy_used: { type: Number, required: true },  // cumulative kWh counter of the meter
  timestamp: { type: Date, default: Date.now }
});

// Every dashboard asks "readings of ONE meter, newest first", so index exactly that.
meterReadingSchema.index({ meter_id: 1, timestamp: -1 });

// Raw readings are deleted automatically after this many days (bills are kept forever).
// Set READING_RETENTION_DAYS=0 to keep everything.
const retentionDays = Number(process.env.READING_RETENTION_DAYS ?? 90);
if (retentionDays > 0) meterReadingSchema.index({ timestamp: 1 }, { expireAfterSeconds: retentionDays * 86400 });

module.exports = mongoose.model("MeterReading", meterReadingSchema);
