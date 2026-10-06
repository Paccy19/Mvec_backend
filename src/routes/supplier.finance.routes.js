const express = require("express");
const router = express.Router();
const finance = require("../controllers/supplierFinance.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Supplier money endpoints. Mounted under /api/suppliers alongside
// supplier.routes.js — every path here starts with /me/, which that router
// never claims, so the two fall through to each other cleanly.
router.use("/me", protect, authorize("supplier"));

router.get("/me/finance/summary", finance.summary);
router.get("/me/finance/ledger", finance.ledger);
router.get("/me/finance/payouts", finance.payouts);
router.post("/me/finance/payouts", finance.requestPayout);
router.get("/me/finance/analytics", finance.analytics);

// Written by the app as a supplier, read back on the Finance page. The
// marketplace `/api/reviews` routes are scoped to buyers and vendors.
router.get("/me/reviews", finance.reviews);

module.exports = router;
