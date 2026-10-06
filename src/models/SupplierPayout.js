const mongoose = require("mongoose");

// A supplier withdrawal. Kept apart from the vendor `Payout` collection so the
// vendor payout routes (`/api/payouts/*`) never see supplier rows: they query
// by user id alone, and a user who holds both a vendor and a supplier account
// would otherwise get a merged history.
const supplierPayoutSchema = new mongoose.Schema(
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
    amount: {
      type: Number,
      required: true,
      min: [1000, "Minimum payout request amount is 1,000 RWF"],
    },
    // Matches the slugs the app sends: MTN_MOMO | AIRTEL_MONEY | BANK_TRANSFER.
    method: {
      type: String,
      enum: ["MTN_MOMO", "AIRTEL_MONEY", "BANK_TRANSFER"],
      default: "MTN_MOMO",
    },
    destination: { type: String, required: true, trim: true },
    note: { type: String, default: "" },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "PAID", "REJECTED", "FAILED"],
      default: "PENDING",
      index: true,
    },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SupplierPayout", supplierPayoutSchema);
