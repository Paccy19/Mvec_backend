const mongoose = require("mongoose");

// Inbound stock the supplier has asked MVEC to source and ship to their store.
// A request walks six steps (raise → review → approval → sourcing → dispatch →
// receiving); `status` records which one it is on, and `events` keeps the audit
// trail the detail sheet renders.
const supplyRequestSchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    reference: {
      type: String,
      unique: true,
      required: true,
    },
    status: {
      type: String,
      enum: [
        "SUBMITTED",
        "UNDER_REVIEW",
        "APPROVED",
        "SOURCING",
        "IN_TRANSIT",
        "RECEIVED",
        "REJECTED",
        "CANCELLED",
      ],
      default: "SUBMITTED",
      index: true,
    },
    lines: [
      {
        product: { type: String, required: true, trim: true },
        category: { type: String, default: "General", trim: true },
        units: { type: Number, required: true, min: 1 },
        unit: { type: String, default: "kg", trim: true },
        unitPrice: { type: Number, required: true, min: 0 },
        note: { type: String, default: "" },
        _id: false,
      },
    ],
    neededBy: { type: Date, default: null },
    note: { type: String, default: "" },
    // Why MVEC approved, rejected or paused the request.
    decision: { type: String, default: null },
    cancelReason: { type: String, default: "" },
    events: [
      {
        at: { type: Date, default: Date.now },
        title: { type: String, required: true },
        detail: { type: String, default: "" },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("SupplyRequest", supplyRequestSchema);
