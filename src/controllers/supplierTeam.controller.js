const SupplierTeamMember = require("../models/SupplierTeamMember");

const ROLES = new Set(["OWNER", "OPERATIONS", "WAREHOUSE", "FULFILMENT", "FINANCE", "VIEWER"]);
const STATUSES = new Set(["ACTIVE", "INVITED", "SUSPENDED"]);

// Reduces any reasonable way of writing a Rwandan number to its 9-digit local
// form, or returns null when it is not one. Mirrors `normalizeRwandanPhone` in
// the app so the same input is understood on both sides.
function normalizeRwandanPhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length > 9 && digits.startsWith("250")) digits = digits.slice(3);
  if (digits.length === 10 && digits.startsWith("0")) digits = digits.slice(1);
  return digits.length === 9 && digits.startsWith("7") ? digits : null;
}

async function ownedMember(userId, id) {
  const member = await SupplierTeamMember.findOne({ _id: id, supplier: userId });
  if (!member) {
    const error = new Error("Team member not found");
    error.status = 404;
    throw error;
  }
  return member;
}

async function hasOwner(userId) {
  return Boolean(await SupplierTeamMember.exists({ supplier: userId, role: "OWNER" }));
}

function bad(res, message, status = 400) {
  return res.status(status).json({ message });
}

// GET /api/suppliers/me/team
exports.members = async (req, res) => {
  try {
    const rows = await SupplierTeamMember.find({ supplier: req.user.id })
      .sort({ createdAt: 1 })
      .lean();
    return res.json({ members: rows });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// GET /api/suppliers/me/team/summary
//
// The roster travels with the counts: the client rebuilds the per-permission
// coverage from the members themselves, and only falls back to these totals if
// the roster is missing.
exports.summary = async (req, res) => {
  try {
    const members = await SupplierTeamMember.find({ supplier: req.user.id })
      .sort({ createdAt: 1 })
      .lean();

    const summary = {
      total: members.length,
      active: members.filter((m) => m.status === "ACTIVE").length,
      invited: members.filter((m) => m.status === "INVITED").length,
      suspended: members.filter((m) => m.status === "SUSPENDED").length,
    };

    return res.json({ summary, members });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// POST /api/suppliers/me/team
exports.addMember = async (req, res) => {
  try {
    const fullName = String(req.body.fullName || "").trim();
    const email = String(req.body.email || "").trim();
    const note = String(req.body.note || "").trim();
    const role = String(req.body.role || "VIEWER").toUpperCase();
    const status = String(req.body.status || "ACTIVE").toUpperCase();

    if (!fullName) return bad(res, "fullName is required");

    const local = normalizeRwandanPhone(req.body.phone);
    if (!local) {
      return bad(res, "Enter a Rwandan number, e.g. +250 788 000 000");
    }

    if (!ROLES.has(role)) return bad(res, `role must be one of ${[...ROLES].join(", ")}`);
    if (!STATUSES.has(status)) return bad(res, `status must be one of ${[...STATUSES].join(", ")}`);
    if (email && !email.includes("@")) return bad(res, "email must be a valid address");

    // One owner per account, enforced here as well as by the partial unique
    // index so the caller gets a sentence rather than a duplicate-key error.
    if (role === "OWNER" && (await hasOwner(req.user.id))) {
      return bad(res, "This account already has an owner", 409);
    }

    const member = await SupplierTeamMember.create({
      supplier: req.user.id,
      fullName,
      phone: `+250${local}`,
      email,
      role,
      status,
      note,
      lastActiveAt: status === "ACTIVE" ? new Date() : null,
    });

    return res.status(201).json({ message: "Team member added", member });
  } catch (error) {
    if (error.code === 11000) {
      return bad(res, "This account already has an owner", 409);
    }
    return res.status(400).json({ message: error.message });
  }
};

// PATCH /api/suppliers/me/team/:id
exports.updateMember = async (req, res) => {
  try {
    const member = await ownedMember(req.user.id, req.params.id);

    // Ownership is fixed on the account: it can neither be moved onto someone
    // else nor stripped from the person who holds it.
    if (member.role === "OWNER") {
      const demoting = req.body.role !== undefined && req.body.role !== "OWNER";
      const suspending =
        req.body.status !== undefined && String(req.body.status).toUpperCase() !== "ACTIVE";
      if (demoting || suspending) {
        return bad(res, "The account owner cannot be changed or suspended", 409);
      }
    }

    if (req.body.fullName !== undefined) {
      const fullName = String(req.body.fullName).trim();
      if (!fullName) return bad(res, "fullName cannot be empty");
      member.fullName = fullName;
    }

    if (req.body.phone !== undefined) {
      const local = normalizeRwandanPhone(req.body.phone);
      if (!local) return bad(res, "Enter a Rwandan number, e.g. +250 788 000 000");
      member.phone = `+250${local}`;
    }

    if (req.body.email !== undefined) {
      const email = String(req.body.email).trim();
      if (email && !email.includes("@")) return bad(res, "email must be a valid address");
      member.email = email;
    }

    if (req.body.note !== undefined) member.note = String(req.body.note).trim();

    if (req.body.role !== undefined) {
      const role = String(req.body.role).toUpperCase();
      if (!ROLES.has(role)) return bad(res, `role must be one of ${[...ROLES].join(", ")}`);
      if (role === "OWNER" && (await hasOwner(req.user.id))) {
        return bad(res, "This account already has an owner", 409);
      }
      member.role = role;
    }

    if (req.body.status !== undefined) {
      const status = String(req.body.status).toUpperCase();
      if (!STATUSES.has(status)) return bad(res, `status must be one of ${[...STATUSES].join(", ")}`);
      member.status = status;
    }

    await member.save();
    return res.json({ member });
  } catch (error) {
    if (error.code === 11000) {
      return bad(res, "This account already has an owner", 409);
    }
    const status = error.status || 400;
    return res.status(status).json({ message: error.message });
  }
};

// DELETE /api/suppliers/me/team/:id
exports.removeMember = async (req, res) => {
  try {
    const member = await ownedMember(req.user.id, req.params.id);

    if (member.role === "OWNER") {
      return bad(res, "The account owner cannot be removed", 409);
    }

    await member.deleteOne();
    return res.json({ message: "Team member removed" });
  } catch (error) {
    const status = error.status || 400;
    return res.status(status).json({ message: error.message });
  }
};
