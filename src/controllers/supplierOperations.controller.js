const SupplyRequest = require("../models/SupplyRequest");
const dashboard = require("../services/supplierDashboard.service");

const MAX_REQUESTS = 100;

const OPEN_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "APPROVED",
  "SOURCING",
  "IN_TRANSIT",
];

const TERMINAL_STATUSES = ["RECEIVED", "REJECTED", "CANCELLED"];

const CANCELLABLE_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "SOURCING"];

// The six-step guide the Supply Requests page renders. Returned from the API so
// the server can change a timeframe or responsibility without waiting on an app
// release; it is the same copy the client ships in `kSupplyProcessSteps`.
const PROCESS_STEPS = [
  {
    stage: "request",
    youDo:
      "Pick the items, the quantities and the date you need them in. MVEC checks availability against your live catalogue as you build the request.",
    mvecDoes:
      "Logs the request under a reference number and locks the catalogue prices so the quote cannot move under you.",
    timeframe: "About 2 minutes",
  },
  {
    stage: "review",
    youDo:
      "Answer whatever the category manager asks — grade, pack size or the delivery window you can actually receive at.",
    mvecDoes:
      "A reviewer checks stock, grading and whether the volume is worth holding for you before quoting.",
    timeframe: "Same working day",
  },
  {
    stage: "approval",
    youDo:
      "Accept or decline the quote. Nothing is charged and nothing is reserved until you accept.",
    mvecDoes:
      "Issues the quote with bulk discount and escrow terms attached, valid for 7 days.",
    timeframe: "1–2 business days",
  },
  {
    stage: "sourcing",
    youDo:
      "Send the lot or harvest details if you are reselling a specific batch, so buyers can be told what they are getting.",
    mvecDoes:
      "Sources the goods, quality checks them and photographs them before anything is packed.",
    timeframe: "3–7 business days",
  },
  {
    stage: "dispatch",
    youDo:
      "Confirm the receiving window and who will sign for the delivery at your store.",
    mvecDoes:
      "Books the consignment with the courier and issues a tracking number you can follow from the Delivery page.",
    timeframe: "1–2 business days",
  },
  {
    stage: "receiving",
    youDo:
      "Inspect on arrival and raise a dispute within 48 hours if the goods do not match the quote.",
    mvecDoes:
      "Releases the funds from escrow to your payout balance once delivery is confirmed.",
    timeframe: "Within 24h of confirmation",
  },
];

function intQuery(value, fallback, { min = 1, max = 200 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// A short supplier-facing code such as `SR-2057`. The four digits are random
// rather than a count, so two requests raised in the same second cannot collide,
// and the unique index backs the last line of defence by forcing a redraw.
async function newReference() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const digits = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await SupplyRequest.exists({ reference: `SR-${digits}` });
    if (!exists) return `SR-${digits}`;
  }
  return `SR-${Date.now().toString(36).toUpperCase()}`;
}

async function ownedRequest(userId, id) {
  const request = await SupplyRequest.findOne({ _id: id, supplier: userId });
  if (!request) {
    const error = new Error("Supply request not found");
    error.status = 404;
    throw error;
  }
  return request;
}

function addEvent(request, title, detail = "") {
  request.events.push({ at: new Date(), title, detail });
}

function bad(res, message, status = 400) {
  return res.status(status).json({ message });
}

// ─── DELIVERY & SETTLEMENT ──────────────────────────────────────────────────

// GET /api/suppliers/me/deliveries?limit=40
exports.deliveries = async (req, res) => {
  try {
    const shipments = await dashboard.shipments(req.user.id, intQuery(req.query.limit, 40));
    return res.json({ shipments });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// GET /api/suppliers/me/settlements?limit=60
exports.settlements = async (req, res) => {
  try {
    const events = await dashboard.settlements(req.user.id, intQuery(req.query.limit, 60));
    return res.json({ settlements: events });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// GET /api/suppliers/me/delivery/summary
exports.deliverySummary = async (req, res) => {
  try {
    const summary = await dashboard.deliverySummary(req.user.id);
    return res.json({ summary });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// ─── SUPPLY REQUESTS ────────────────────────────────────────────────────────

// GET /api/suppliers/me/supply-requests?limit=40
exports.listRequests = async (req, res) => {
  try {
    const limit = intQuery(req.query.limit, 40, { max: MAX_REQUESTS });
    const rows = await SupplyRequest.find({ supplier: req.user.id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ requests: rows });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// GET /api/suppliers/me/supply-requests/process
exports.process = (req, res) => res.json({ steps: PROCESS_STEPS });

// POST /api/suppliers/me/supply-requests
exports.createRequest = async (req, res) => {
  try {
    const rawLines = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!rawLines.length) {
      return bad(res, "lines must contain at least one item");
    }

    const lines = [];
    for (const [index, line] of rawLines.entries()) {
      const product = String(line.product || line.name || "").trim();
      const units = Number(line.units ?? line.quantity);
      const unitPrice = Number(line.unitPrice ?? line.price);

      if (!product) return bad(res, `lines[${index}].product is required`);
      if (!Number.isFinite(units) || units <= 0) {
        return bad(res, `lines[${index}].units must be a positive number`);
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return bad(res, `lines[${index}].unitPrice must be zero or more`);
      }

      lines.push({
        product,
        category: String(line.category || "General").trim() || "General",
        units: Math.round(units),
        unit: String(line.unit || "kg").trim() || "kg",
        unitPrice: Math.round(unitPrice),
        note: String(line.note || "").trim(),
      });
    }

    const neededBy = req.body.neededBy ? new Date(req.body.neededBy) : null;
    if (!neededBy || Number.isNaN(neededBy.getTime())) {
      return bad(res, "neededBy must be a valid date");
    }

    const request = await SupplyRequest.create({
      supplier: req.user.id,
      reference: await newReference(),
      status: "SUBMITTED",
      lines,
      neededBy,
      note: String(req.body.note || "").trim(),
      decision: null,
      cancelReason: "",
      events: [],
    });

    addEvent(
      request,
      "Request raised",
      `MVEC logs ${lines.length} line(s) under ${request.reference}`
    );
    await request.save();

    return res.status(201).json({ message: "Supply request raised", request });
  } catch (error) {
    if (error.code === 11000) {
      return bad(res, "That reference number is already in use, please retry", 409);
    }
    return res.status(400).json({ message: error.message });
  }
};

// POST /api/suppliers/me/supply-requests/:id/cancel
exports.cancelRequest = async (req, res) => {
  try {
    const request = await ownedRequest(req.user.id, req.params.id);

    if (!CANCELLABLE_STATUSES.includes(request.status)) {
      return bad(
        res,
        `A ${request.status.toLowerCase().replace("_", " ")} request can no longer be cancelled`,
        409
      );
    }

    const reason = String(req.body.reason || "").trim();
    if (!reason) return bad(res, "reason is required");

    request.status = "CANCELLED";
    request.cancelReason = reason;
    addEvent(request, "Cancelled by supplier", reason);
    await request.save();

    return res.json({ request });
  } catch (error) {
    const status = error.status || 400;
    return res.status(status).json({ message: error.message });
  }
};

// POST /api/suppliers/me/supply-requests/:id/resubmit
//
// Only a cancelled request can be put back on the pile — that is the one state
// the app offers a resubmit button for, so anything else is a stale call.
exports.resubmitRequest = async (req, res) => {
  try {
    const request = await ownedRequest(req.user.id, req.params.id);

    if (request.status !== "CANCELLED") {
      return bad(res, "Only a cancelled request can be resubmitted", 409);
    }

    request.status = "SUBMITTED";
    request.cancelReason = "";
    request.decision = null;
    addEvent(request, "Resubmitted by supplier", "Back in the queue for review");
    await request.save();

    return res.json({ request });
  } catch (error) {
    const status = error.status || 400;
    return res.status(status).json({ message: error.message });
  }
};

exports.OPEN_STATUSES = OPEN_STATUSES;
exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
