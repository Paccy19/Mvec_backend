// Reads the supplier dashboard's money and delivery views out of the data the
// platform already keeps: `WholesaleOrder` (the supplier's B2B orders),
// `VendorWallet` (where `wholesale.service` credits released escrow) and
// `SupplierPayout` (withdrawals).
//
// Nothing here writes. Every figure is derived from an order or a wallet row
// the rest of the backend already owns, so this service cannot drift from what
// the payments pipeline actually does.
const WholesaleOrder = require("../models/WholesaleOrder");
const WholesaleProduct = require("../models/WholesaleProduct");
const VendorWallet = require("../models/VendorWallet");
const SupplierPayout = require("../models/SupplierPayout");
const Supplier = require("../models/Supplier");
const User = require("../models/User");

// No commission is withheld from a wholesale order today: `wholesale.service`
// credits 100% of `totalAmount` to the supplier wallet on release. Reporting a
// rate here would put the summary out of step with the money that actually
// moves, so both stay at zero until a split is implemented for suppliers.
const COMMISSION_RATE = 0;

const ESCROW_STATUSES = ["ESCROW_HELD", "SHIPPED", "DELIVERED", "DISPUTED"];
const RELEASED_STATUS = "CONFIRMED_RELEASED";
const CANCELLED_STATUS = "CANCELLED";

const DAY_MS = 24 * 60 * 60 * 1000;

// The app sends `30d` / `3m` / `1y`.
const RANGE_DAYS = { "30d": 30, "3m": 90, "1y": 365 };

function rangeDays(range) {
  return RANGE_DAYS[range] || RANGE_DAYS["30d"];
}

function windowFor(days, now = Date.now()) {
  const to = new Date(now);
  const from = new Date(now - days * DAY_MS);
  const prevFrom = new Date(now - 2 * days * DAY_MS);
  return { from, to, prevFrom, prevTo: from };
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

const commissionOf = (gross) => round2((gross * COMMISSION_RATE) / 100);
const netOf = (gross) => round2(gross - commissionOf(gross));

const inWindow = (date, from, to) => date && date >= from && date <= to;

const unitsOf = (order) =>
  (order.items || []).reduce((sum, item) => sum + (item.quantity || 0), 0);

const isLive = (order) => order.status !== CANCELLED_STATUS;

// WholesaleOrder.status → the delivery stage the app renders. `DELIVERED` and
// `CONFIRMED_RELEASED` both mean the buyer has the goods, so both land on the
// terminal step; `DISPUTED` is a consignment that has stopped moving.
const STAGE_BY_STATUS = {
  PENDING_PAYMENT: "CONFIRMED",
  ESCROW_HELD: "PACKED",
  SHIPPED: "DISPATCHED",
  DELIVERED: "DELIVERED",
  CONFIRMED_RELEASED: "DELIVERED",
  DISPUTED: "DISPATCHED",
  CANCELLED: "CONFIRMED",
};

// Only milestones the order actually timestamps are emitted. The model has no
// "packed" or "out for delivery" date, so those steps come back unset and the
// screen draws them dashed rather than showing a time we invented.
function milestonesOf(order) {
  const steps = [{ stage: "CONFIRMED", at: order.createdAt }];
  if (order.shippedAt) steps.push({ stage: "DISPATCHED", at: order.shippedAt });
  if (order.deliveredAt) steps.push({ stage: "DELIVERED", at: order.deliveredAt });
  if (order.confirmedAt) steps.push({ stage: "DELIVERED", at: order.confirmedAt });
  return steps;
}

async function loadOrders(userId) {
  return WholesaleOrder.find({ supplier: userId }).sort({ createdAt: -1 }).lean();
}

async function loadWallet(userId) {
  return (await VendorWallet.findOne({ vendor: userId }).lean()) || null;
}

async function loadPayouts(userId) {
  return SupplierPayout.find({ supplier: userId }).sort({ createdAt: -1 }).lean();
}

// Cleared money a supplier may withdraw right now: the wallet balance less any
// withdrawal already in flight. Reserving pending payouts here is what stops
// the same balance being requested twice.
async function payoutBalance(userId) {
  const wallet = await loadWallet(userId);
  const payouts = await loadPayouts(userId);
  const pending = payouts
    .filter((payout) => payout.status === "PENDING" || payout.status === "PROCESSING")
    .reduce((sum, payout) => sum + (payout.amount || 0), 0);
  const walletBalance = wallet ? wallet.availableBalance || 0 : 0;
  return {
    walletBalance: round2(walletBalance),
    pending: round2(pending),
    available: Math.max(0, round2(walletBalance - pending)),
  };
}

async function supplierDocFor(userId) {
  return Supplier.findOne({ user: userId }).lean();
}

// Supplier products are keyed on the Supplier document, not the user id.
async function categoryNameByProduct(userId) {
  const supplier = await supplierDocFor(userId);
  if (!supplier) return {};
  const rows = await WholesaleProduct.find({ supplier: supplier._id }).lean();
  const map = {};
  for (const row of rows) map[row.name] = row.category || "General";
  return map;
}

async function displayNames(userIds) {
  if (!userIds.length) return {};
  const rows = await User.find({ _id: { $in: userIds } }).lean();
  const map = {};
  for (const row of rows) map[String(row._id)] = row.Fullname || row.email || "Vendor";
  return map;
}

// Buckets gross/net/units per calendar day across a window, oldest first, so
// the earnings chart always has a point per day even on a quiet day.
function dailySeries(orders, from, to) {
  const days = Math.max(1, Math.ceil((to - from) / DAY_MS));
  const buckets = [];
  for (let i = 0; i < days; i++) {
    const at = new Date(from.getTime() + i * DAY_MS);
    buckets.push({ at, gross: 0, units: 0, count: 0 });
  }
  const span = to - from;
  for (const order of orders) {
    if (!order.createdAt || order.createdAt < from || order.createdAt > to) continue;
    const index = Math.min(days - 1, Math.floor((order.createdAt - from) / span * days));
    buckets[index].gross += order.totalAmount || 0;
    buckets[index].units += unitsOf(order);
    buckets[index].count += 1;
  }
  return buckets.map((bucket) => ({
    at: bucket.at.toISOString(),
    net: netOf(bucket.gross),
    units: bucket.units,
  }));
}

// ── Finance & Insights ──────────────────────────────────────────────────────

async function financeSummary(userId) {
  const orders = (await loadOrders(userId)).filter(isLive);
  const balance = await payoutBalance(userId);

  const now = Date.now();
  const current = windowFor(30, now);
  const previous = windowFor(60, now);

  const grossAll = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
  const commissionAll = orders.reduce((sum, order) => sum + commissionOf(order.totalAmount || 0), 0);

  const escrowHeld = orders
    .filter((order) => ESCROW_STATUSES.includes(order.status))
    .reduce((sum, order) => sum + (order.totalAmount || 0), 0);

  const sumBetween = (from, to) =>
    orders
      .filter((order) => inWindow(order.createdAt, from, to))
      .reduce((sum, order) => sum + (order.totalAmount || 0), 0);

  const grossDelta = sumBetween(current.from, current.to);
  const grossPrev = sumBetween(previous.prevFrom, previous.prevTo);

  const lastPaid = (await loadPayouts(userId)).find(
    (payout) => payout.status === "PAID"
  );

  return {
    grossSales: round2(grossAll),
    commission: round2(commissionAll),
    netEarnings: round2(grossAll - commissionAll),
    escrowHeld: round2(escrowHeld),
    availablePayout: balance.available,
    pendingPayouts: balance.pending,
    commissionRate: COMMISSION_RATE,
    salesDelta: grossPrev > 0 ? round2((grossDelta - grossPrev) / grossPrev) : 0,
    earningsDelta: grossPrev > 0 ? round2((grossDelta - grossPrev) / grossPrev) : 0,
    series: dailySeries(orders, current.from, current.to),
    lastPayoutAt: lastPaid ? (lastPaid.processedAt || lastPaid.createdAt) : null,
  };
}

// Every non-cancelled order books exactly one signed amount: an order still in
// escrow posts SALE (it is earned but held) plus a neutral ESCROW_HOLD marker
// that explains why it is not withdrawable; an order already released posts
// ESCROW_RELEASE instead of SALE, so the money is never counted twice.
async function financeLedger(userId, { kind, limit } = {}) {
  const orders = (await loadOrders(userId)).filter(isLive);
  const payouts = await loadPayouts(userId);
  const rows = [];

  for (const order of orders) {
    const released = order.status === RELEASED_STATUS;
    const held = ESCROW_STATUSES.includes(order.status);

    if (released) {
      rows.push({
        _id: `${order._id}-release`,
        kind: "ESCROW_RELEASE",
        at: order.confirmedAt || order.updatedAt || order.createdAt,
        amount: round2(order.totalAmount || 0),
        description: `Escrow released for ${order.orderNumber}`,
        orderNumber: order.orderNumber,
        units: unitsOf(order),
      });
      continue;
    }

    rows.push({
      _id: `${order._id}-sale`,
      kind: "SALE",
      at: order.createdAt,
      amount: round2(order.totalAmount || 0),
      description: `Wholesale order ${order.orderNumber}`,
      orderNumber: order.orderNumber,
      units: unitsOf(order),
    });

    if (held) {
      rows.push({
        _id: `${order._id}-hold`,
        kind: "ESCROW_HOLD",
        at: order.createdAt,
        amount: round2(order.totalAmount || 0),
        description: "Funds held in escrow until delivery is confirmed",
        orderNumber: order.orderNumber,
        units: unitsOf(order),
      });
    }
  }

  for (const payout of payouts) {
    rows.push({
      _id: payout._id,
      kind: "PAYOUT",
      at: payout.createdAt,
      amount: round2(payout.amount || 0),
      description: payout.note ? `Withdrawal — ${payout.note}` : "Withdrawal",
      payoutMethod: payout.method,
      payoutStatus: payout.status,
      balanceAfter: null,
    });
  }

  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  const filtered = kind ? rows.filter((row) => row.kind === kind) : rows;
  return limit ? filtered.slice(0, limit) : filtered;
}

async function financePayouts(userId, limit = 30) {
  const payouts = await loadPayouts(userId);
  return payouts.slice(0, limit).map((payout) => ({
    _id: payout._id,
    amount: payout.amount,
    method: payout.method,
    destination: payout.destination,
    note: payout.note,
    status: payout.status,
    requestedAt: payout.createdAt,
    arrivedAt: payout.status === "PAID" ? payout.processedAt || payout.createdAt : null,
  }));
}

async function analyticsSnapshot(userId, range) {
  const days = rangeDays(range);
  const orders = (await loadOrders(userId)).filter(isLive);
  const categoryByName = await categoryNameByProduct(userId);

  const { from, to, prevFrom, prevTo } = windowFor(days);
  const inRange = orders.filter((order) => inWindow(order.createdAt, from, to));
  const inPrev = orders.filter((order) => inWindow(order.createdAt, prevFrom, prevTo));

  const total = (rows) => rows.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
  const gross = total(inRange);
  const commission = inRange.reduce((sum, order) => sum + commissionOf(order.totalAmount || 0), 0);
  const previousGross = total(inPrev);

  const orderCount = inRange.length;
  const unitsSold = inRange.reduce((sum, order) => sum + unitsOf(order), 0);
  const netEarnings = round2(gross - commission);

  // Category and product breakdowns come from the order lines themselves; the
  // catalogue is only consulted to give a line its category label.
  const byCategory = new Map();
  const byProduct = new Map();
  for (const order of inRange) {
    for (const item of order.items || []) {
      const name = item.productName || "Item";
      const lineGross = (item.unitPrice || 0) * (item.quantity || 0);
      const category = categoryByName[name] || "General";

      const categoryRow = byCategory.get(category) || { category, revenue: 0, units: 0 };
      categoryRow.revenue += netOf(lineGross);
      categoryRow.units += item.quantity || 0;
      byCategory.set(category, categoryRow);

      const productRow = byProduct.get(name) || { name, category, revenue: 0, units: 0 };
      productRow.revenue += netOf(lineGross);
      productRow.units += item.quantity || 0;
      byProduct.set(name, productRow);
    }
  }

  const categories = [...byCategory.values()]
    .map((row) => ({ ...row, revenue: round2(row.revenue), share: gross > 0 ? row.revenue / gross : 0 }))
    .sort((a, b) => b.revenue - a.revenue);

  const topProducts = [...byProduct.values()]
    .map((row) => ({ ...row, revenue: round2(row.revenue) }))
    .sort((a, b) => b.units - a.units)
    .slice(0, 5);

  const delta = (current, previous) =>
    previous > 0 ? round2((current - previous) / previous) : 0;

  return {
    range,
    grossSales: round2(gross),
    commission: round2(commission),
    netEarnings,
    orderCount,
    unitsSold,
    averageOrderValue: orderCount > 0 ? round2(netEarnings / orderCount) : 0,
    salesDelta: delta(gross, previousGross),
    earningsDelta: delta(netEarnings, previousGross),
    orderDelta: delta(orderCount, inPrev.length),
    series: dailySeries(inRange, from, to),
    categories,
    topProducts,
  };
}

// Reviews are stored against the marketplace `Order` collection, so a supplier's
// reviews are the ones written on orders whose id appears in their wholesale
// order history. The payload is mapped onto the app's field names because the
// Review document calls them `reviewText` and `vendorReply`.
async function reviews(userId, limit = 50) {
  const orders = await loadOrders(userId);
  const orderIds = orders.map((order) => order._id);
  if (!orderIds.length) return [];

  const orderNumberById = {};
  for (const order of orders) orderNumberById[String(order._id)] = order.orderNumber;

  const rows = await require("../models/Review")
    .find({ parentOrder: { $in: orderIds }, status: { $ne: "HIDDEN" } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const authors = await displayNames(rows.map((row) => row.user));

  return rows.map((row) => ({
    _id: row._id,
    author: authors[String(row.user)] || "Marketplace buyer",
    rating: row.rating,
    comment: row.reviewText || "",
    createdAt: row.createdAt,
    orderNumber: orderNumberById[String(row.parentOrder)] || null,
    reply: row.vendorReply && row.vendorReply.text ? row.vendorReply.text : null,
  }));
}

// ── Delivery & settlement ───────────────────────────────────────────────────

async function shipments(userId, limit = 40) {
  const orders = (await loadOrders(userId)).filter(isLive);
  const vendors = await displayNames(orders.map((order) => order.vendor));

  return orders.slice(0, limit).map((order) => ({
    _id: order._id,
    orderNumber: order.orderNumber,
    buyer: vendors[String(order.vendor)] || "Marketplace vendor",
    product: (order.items || []).map((item) => item.productName).filter(Boolean).join(", ") || "Wholesale item",
    units: unitsOf(order),
    gross: round2(order.totalAmount || 0),
    net: netOf(order.totalAmount || 0),
    // The wholesale order carries no shipping address; the app falls back to
    // its own default when this is absent.
    destination: null,
    stage: STAGE_BY_STATUS[order.status] || "CONFIRMED",
    milestones: milestonesOf(order),
    eta: null,
    deliveredAt: order.deliveredAt || null,
    settledAt: order.confirmedAt || null,
    holdReason: order.status === "DISPUTED" ? "Paused pending dispute review" : null,
  }));
}

// A settlement row per movement of escrow: a hold while the money is locked, a
// scheduled release once the buyer has the goods, a settled release once the
// OTP is confirmed, a refund for a cancelled order, and a withdrawal row per
// payout request.
async function settlements(userId, limit = 60) {
  const orders = await loadOrders(userId);
  const payouts = await loadPayouts(userId);
  const rows = [];

  for (const order of orders) {
    const held = ESCROW_STATUSES.includes(order.status) && order.status !== "DISPUTED";

    if (order.status === CANCELLED_STATUS) {
      rows.push({
        _id: `${order._id}-refund`,
        kind: "REFUND",
        at: order.updatedAt || order.createdAt,
        amount: round2(order.totalAmount || 0),
        description: `Cancelled — ${order.orderNumber}`,
        orderNumber: order.orderNumber,
        settledAt: order.updatedAt || order.createdAt,
      });
      continue;
    }

    if (held) {
      rows.push({
        _id: `${order._id}-hold`,
        kind: "ESCROW_HOLD",
        at: order.createdAt,
        amount: round2(order.totalAmount || 0),
        description: `Escrow held for ${order.orderNumber}`,
        orderNumber: order.orderNumber,
        expectedAt: null,
        settledAt: null,
      });
    }

    if (order.status === RELEASED_STATUS) {
      rows.push({
        _id: `${order._id}-release`,
        kind: "ESCROW_RELEASE",
        at: order.confirmedAt || order.updatedAt || order.createdAt,
        amount: round2(order.totalAmount || 0),
        description: `Released for ${order.orderNumber}`,
        orderNumber: order.orderNumber,
        expectedAt: null,
        settledAt: order.confirmedAt || order.updatedAt || order.createdAt,
      });
    } else if (order.status === "DELIVERED" || order.status === "DISPUTED") {
      rows.push({
        _id: `${order._id}-due`,
        kind: "ESCROW_RELEASE",
        at: order.deliveredAt || order.createdAt,
        amount: round2(order.totalAmount || 0),
        description: `Release due for ${order.orderNumber}`,
        orderNumber: order.orderNumber,
        expectedAt: order.deliveredAt || null,
        settledAt: null,
      });
    }
  }

  for (const payout of payouts) {
    const paid = payout.status === "PAID";
    rows.push({
      _id: payout._id,
      kind: "PAYOUT",
      at: payout.createdAt,
      amount: round2(payout.amount || 0),
      description: payout.note ? `Withdrawal — ${payout.note}` : "Withdrawal",
      expectedAt: paid ? null : payout.createdAt,
      settledAt: paid ? payout.processedAt || payout.createdAt : null,
    });
  }

  rows.sort((a, b) => new Date(b.at) - new Date(a.at));
  return rows.slice(0, limit);
}

async function deliverySummary(userId) {
  const orders = (await loadOrders(userId)).filter(isLive);
  const payouts = await loadPayouts(userId);

  const now = Date.now();
  const monthAgo = new Date(now - 30 * DAY_MS);

  const activeStatuses = ["ESCROW_HELD", "SHIPPED", "DISPUTED"];
  const active = orders.filter((order) => activeStatuses.includes(order.status));

  const deliveredRecently = orders.filter(
    (order) =>
      (order.status === "DELIVERED" || order.status === RELEASED_STATUS) &&
      inWindow(order.deliveredAt || order.confirmedAt, monthAgo, new Date(now))
  );

  const inEscrow = orders
    .filter((order) => ESCROW_STATUSES.includes(order.status))
    .reduce((sum, order) => sum + (order.totalAmount || 0), 0);

  const scheduledRows = orders.filter((order) => order.status === "DELIVERED");
  const scheduled = scheduledRows.reduce((sum, order) => sum + (order.totalAmount || 0), 0);

  const releasedThisPeriod = orders
    .filter(
      (order) =>
        order.status === RELEASED_STATUS && inWindow(order.confirmedAt, monthAgo, new Date(now))
    )
    .reduce((sum, order) => sum + (order.totalAmount || 0), 0);

  const dueDates = scheduledRows
    .map((order) => order.deliveredAt)
    .filter(Boolean)
    .sort((a, b) => a - b);

  // A wholesale order has no promised-by date, so an on-time rate cannot be
  // computed honestly. It stays at zero rather than being guessed from a
  // fabricated ETA.
  return {
    activeShipments: active.length,
    deliveredThisMonth: deliveredRecently.length,
    inEscrow: round2(inEscrow),
    scheduled: round2(scheduled),
    releasedThisPeriod: round2(releasedThisPeriod),
    heldOrders: orders.filter((order) => order.status === "DISPUTED").length,
    onTimeRate: 0,
    nextReleaseAt: dueDates.length ? dueDates[0] : null,
    // Pending withdrawals are shown alongside the escrow figure on the page.
    pendingPayouts: round2(
      payouts
        .filter((payout) => payout.status === "PENDING" || payout.status === "PROCESSING")
        .reduce((sum, payout) => sum + (payout.amount || 0), 0)
    ),
  };
}

module.exports = {
  COMMISSION_RATE,
  financeSummary,
  financeLedger,
  financePayouts,
  payoutBalance,
  analyticsSnapshot,
  reviews,
  shipments,
  settlements,
  deliverySummary,
  netOf,
  round2,
};
