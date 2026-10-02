const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema({
  actor: { type: String, default: "admin" },
  action: { type: String, required: true },
  entity: { type: String, required: true },
  entityId: { type: String, default: "" },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  ip: { type: String, default: "local" }
}, { timestamps: true });

module.exports = mongoose.model("AuditLog", auditLogSchema);
