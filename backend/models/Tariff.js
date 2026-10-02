const mongoose = require("mongoose");

const tariffSchema = new mongoose.Schema({
  name: { type: String, required: true },
  from: { type: Number, required: true, min: 0 },
  to: { type: Number, default: null },
  rate: { type: Number, required: true, min: 0 },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model("Tariff", tariffSchema);
