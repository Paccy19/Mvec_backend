const SupplierPayout = require("../models/SupplierPayout");
const dashboard = require("../services/supplierDashboard.service");

// The lowest withdrawal the supplier portal will accept, in RWF. Mirrors
// `kMinSupplierPayoutAmount` in the app so a request the form already refused
// cannot arrive here by another route.
const MIN_PAYOUT_AMOUNT = 50000;

const LEDGER_KINDS = new Set([
  "SALE",
  "COMMISSION",
  "ESCROW_HOLD",
  "ESCROW_RELEASE",
  "PAYOUT",
  "REFUND",
  "ADJUSTMENT",
]);

const PAYOUT_METHODS = new Set(["MTN_MOMO", "AIRTEL_MONEY", "BANK_TRANSFER"]);
const REPORT_RANGES = new Set(["30d", "3m", "1y"]);

// Reads a positive integer query parameter, falling back when the value is
// absent or malformed rather than failing the whole request over one number.
function intQuery(value, fallback, { min = 1, max = 500 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bad(res, message) {
  return res.status(400).json({ message });
}

// ─── MONEY ──────────────────────────────────────────────────────────────────

// GET /api/suppliers/me/finance/summary
exports.summary = async (req, res) => {
  try {
    const summary = await dashboard.financeSummary(req.user.id);
    return res.json({ summary });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// GET /api/suppliers/me/finance/ledger?kind=&limit=
exports.ledger = async (req, res) => {
  try {
    const { kind } = req.query;
    if (kind !== undefined && !LEDGER_KINDS.has(String(kind).toUpperCase())) {
      return bad(res, `Unknown ledger kind: ${kind}`);
    }

    const entries = await dashboard.financeLedger(req.user.id, {
      kind: kind ? String(kind).toUpperCase() : undefined,
      limit: intQuery(req.query.limit, 50),
    });
    return res.json({ entries });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// GET /api/suppliers/me/finance/payouts?limit=
exports.payouts = async (req, res) => {
  try {
    const rows = await dashboard.financePayouts(req.user.id, intQuery(req.query.limit, 30));
    return res.json({ payouts: rows });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// POST /api/suppliers/me/finance/payouts
//
// The wallet is deliberately left untouched: a PENDING request only reserves
// the amount against the balance (see `payoutBalance`), so nothing is removed
// from the supplier's funds until the withdrawal is actually processed. That
// keeps a rejected or abandoned request from burning money.
exports.requestPayout = async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const method = String(req.body.method || "").toUpperCase();
    const destination = String(req.body.destination || "").trim();
    const note = String(req.body.note || "").trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      return bad(res, "amount must be a positive number");
    }
    if (amount < MIN_PAYOUT_AMOUNT) {
      return bad(res, `Minimum withdrawal amount is ${MIN_PAYOUT_AMOUNT} RWF`);
    }
    if (!PAYOUT_METHODS.has(method)) {
      return bad(res, `method must be one of ${[...PAYOUT_METHODS].join(", ")}`);
    }
    if (!destination) {
      return bad(res, "destination is required");
    }

    const balance = await dashboard.payoutBalance(req.user.id);
    if (amount > balance.available) {
      return res.status(409).json({
        message: "Insufficient cleared balance for this withdrawal",
        availablePayout: balance.available,
        requested: amount,
      });
    }

    const payout = await SupplierPayout.create({
      supplier: req.user.id,
      reference: `SP-${Date.now().toString(36).toUpperCase()}`,
      amount: dashboard.round2(amount),
      method,
      destination,
      note,
      status: "PENDING",
    });

    return res.status(201).json({
      message: "Withdrawal request received",
      payout,
      availablePayout: dashboard.round2(balance.available - amount),
      pendingPayouts: dashboard.round2(balance.pending + amount),
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// ─── INSIGHTS ───────────────────────────────────────────────────────────────

// GET /api/suppliers/me/finance/analytics?range=30d|3m|1y
exports.analytics = async (req, res) => {
  try {
    const range = String(req.query.range || "30d");
    if (!REPORT_RANGES.has(range)) {
      return bad(res, `range must be one of ${[...REPORT_RANGES].join(", ")}`);
    }

    const analytics = await dashboard.analyticsSnapshot(req.user.id, range);
    return res.json({ analytics });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// GET /api/suppliers/me/reviews?limit=50
exports.reviews = async (req, res) => {
  try {
    const rows = await dashboard.reviews(req.user.id, intQuery(req.query.limit, 50));
    return res.json({ reviews: rows });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};
