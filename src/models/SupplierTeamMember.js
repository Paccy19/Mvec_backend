const mongoose = require("mongoose");

// Who works on a supplier's account. Distinct from the vendor `Staff` model,
// which is bound to a store and only carries three vendor roles — the supplier
// roster has its own six roles and is keyed on the supplier's user id instead.
//
// Permissions are not stored: the app derives the full grant from `role`
// (`TeamRole.permissions`), so widening a role later widens every member who
// holds it without a migration.
const supplierTeamMemberSchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    fullName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, default: "", trim: true },
    role: {
      type: String,
      enum: ["OWNER", "OPERATIONS", "WAREHOUSE", "FULFILMENT", "FINANCE", "VIEWER"],
      default: "VIEWER",
      required: true,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "INVITED", "SUSPENDED"],
      default: "ACTIVE",
      index: true,
    },
    note: { type: String, default: "" },
    lastActiveAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One owner per account: the roster can never be left without someone who can
// manage it. Only checked on create — an existing owner is updated in place.
supplierTeamMemberSchema.index(
  { supplier: 1, role: 1 },
  { unique: true, partialFilterExpression: { role: "OWNER" } }
);

module.exports = mongoose.model("SupplierTeamMember", supplierTeamMemberSchema);
