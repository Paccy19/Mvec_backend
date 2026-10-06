const express = require("express");
const router = express.Router();
const operations = require("../controllers/supplierOperations.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Supplier delivery, settlement and inbound-supply endpoints, mounted under
// /api/suppliers next to supplier.routes.js.
router.use("/me", protect, authorize("supplier"));

router.get("/me/deliveries", operations.deliveries);
router.get("/me/settlements", operations.settlements);
router.get("/me/delivery/summary", operations.deliverySummary);

// Registered ahead of the /:id routes so the literal path always wins.
router.get("/me/supply-requests/process", operations.process);
router.get("/me/supply-requests", operations.listRequests);
router.post("/me/supply-requests", operations.createRequest);
router.post("/me/supply-requests/:id/cancel", operations.cancelRequest);
router.post("/me/supply-requests/:id/resubmit", operations.resubmitRequest);

module.exports = router;
