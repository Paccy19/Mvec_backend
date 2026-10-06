const express = require("express");
const router = express.Router();
const team = require("../controllers/supplierTeam.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Supplier staff roster, mounted under /api/suppliers next to
// supplier.routes.js. Deliberately separate from /api/staff, which is bound to
// a store and only carries the three vendor roles.
router.use("/me", protect, authorize("supplier"));

// Declared before /me/team/:id so the literal path always wins.
router.get("/me/team/summary", team.summary);
router.get("/me/team", team.members);
router.post("/me/team", team.addMember);
router.patch("/me/team/:id", team.updateMember);
router.delete("/me/team/:id", team.removeMember);

module.exports = router;
