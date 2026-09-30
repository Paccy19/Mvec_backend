// Regression cover for supplier wholesale product creation.
//
// Background: the WholesaleProduct schema declared its pre("validate") hook as
// `function (next)` and called next(). Mongoose 9 no longer supplies that
// callback, so every product creation failed with "next is not a function".
//
// NOTE: this suite talks to the real configured MongoDB. It scopes every write
// and every cleanup to documents it created itself (email/tag prefix), because
// the dev database holds real data. It must never call deleteMany({}).

process.env.NODE_ENV = "test";
// server.js binds a port on import; move it off 4000 so a running dev server
// does not make the suite die with EADDRINUSE.
process.env.PORT = process.env.PORT || "3999";

const mongoose = require("mongoose");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const importedApp = require("../../server");
const app = importedApp.app || importedApp.default || importedApp;

const User = require("../../src/models/User");
const Supplier = require("../../src/models/Supplier");
const WholesaleProduct = require("../../src/models/WholesaleProduct");

const JWT_SECRET = process.env.JWT_SECRET || "test_secret_key";
const TAG = "wholesale-regression";

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
// Matches the User.phone validator: optional 0, then 7[2389] + 7 digits.
const uniquePhone = () => `07${"2389"[Math.floor(Math.random() * 4)]}${stamp().slice(-7)}`;

describe("Supplier wholesale catalogue", () => {
  let supplierUser;
  let supplier;
  let buyer;
  let token;
  let buyerToken;
  let createdProductIds = [];

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    }
  });

  beforeEach(async () => {
    supplierUser = await User.create({
      Fullname: `WS Supplier ${TAG}`,
      email: `ws-supplier-${stamp()}@example.com`,
      password: "password123",
      phone: uniquePhone(),
      gender: "other",
      role: "supplier",
    });

    supplier = await Supplier.create({
      user: supplierUser._id,
      businessName: `WS Supplier ${TAG}`,
      phone: "0788000001",
      email: supplierUser.email,
    });

    buyer = await User.create({
      Fullname: `WS Buyer ${TAG}`,
      email: `ws-buyer-${stamp()}@example.com`,
      password: "password123",
      phone: uniquePhone(),
      gender: "other",
      role: "buyer",
    });

    token = jwt.sign({ userId: supplierUser._id }, JWT_SECRET, { expiresIn: "1h" });
    buyerToken = jwt.sign({ userId: buyer._id }, JWT_SECRET, { expiresIn: "1h" });
  });

  afterEach(async () => {
    // Scoped cleanup only — never touch documents this suite did not create.
    const ids = createdProductIds.map((id) => new mongoose.Types.ObjectId(id));
    if (ids.length) await WholesaleProduct.deleteMany({ _id: { $in: ids } });
    createdProductIds = [];
    if (supplier) await Supplier.deleteMany({ _id: supplier._id });
    if (supplierUser) await User.deleteMany({ _id: supplierUser._id });
    if (buyer) await User.deleteMany({ _id: buyer._id });
  });

  const create = (body) =>
    request(app)
      .post("/api/suppliers/me/products")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  describe("POST /api/suppliers/me/products", () => {
    it("creates a wholesale product", async () => {
      const res = await create({
        name: "Premium Arabica Beans",
        shortDescription: "Washed arabica, 1kg bag",
        category: "Grains",
        unit: "bag",
        wholesalePrice: 8500,
        retailPrice: 12000,
        moq: 10,
        stockQuantity: 200,
        bulkDiscount: 5,
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.product.name).toBe("Premium Arabica Beans");
      expect(String(res.body.product.supplier)).toBe(String(supplier._id));
      createdProductIds.push(res.body.product._id);
    });

    it("still applies the pre-validate stock rule", async () => {
      // The hook must keep working after the callback removal: a product with
      // no stock has to be downgraded to OUT_OF_STOCK, not silently ACTIVE.
      const res = await create({ name: "Empty Sack", wholesalePrice: 100, stockQuantity: 0 });

      expect(res.status).toBe(201);
      expect(res.body.product.status).toBe("OUT_OF_STOCK");
      createdProductIds.push(res.body.product._id);
    });

    it("keeps an ARCHIVED product archived even at zero stock", async () => {
      const res = await create({
        name: "Retired Item",
        wholesalePrice: 100,
        stockQuantity: 0,
        status: "ARCHIVED",
      });

      expect(res.status).toBe(201);
      expect(res.body.product.status).toBe("ARCHIVED");
      createdProductIds.push(res.body.product._id);
    });

    it("rejects a product without a name", async () => {
      const res = await create({ wholesalePrice: 100 });
      expect(res.status).toBe(400);
    });

    it("rejects a negative wholesale price", async () => {
      const res = await create({ name: "Bad Price", wholesalePrice: -5 });
      expect(res.status).toBe(400);
    });

    it("refuses a buyer", async () => {
      const res = await request(app)
        .post("/api/suppliers/me/products")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ name: "Not Allowed", wholesalePrice: 100 });

      expect(res.status).toBe(403);
    });

    it("rejects an unauthenticated request", async () => {
      const res = await request(app)
        .post("/api/suppliers/me/products")
        .send({ name: "Anonymous", wholesalePrice: 100 });

      expect(res.status).toBe(401);
    });
  });

  describe("product lifecycle", () => {
    it("lists, updates and deletes the supplier's own products", async () => {
      const created = await create({
        name: "Lifecycle Item",
        wholesalePrice: 500,
        stockQuantity: 40,
        moq: 5,
      });
      expect(created.status).toBe(201);
      const id = created.body.product._id;
      createdProductIds.push(id);

      const list = await request(app)
        .get("/api/suppliers/me/products")
        .set("Authorization", `Bearer ${token}`);
      expect(list.status).toBe(200);
      expect(list.body.products.some((p) => p._id === id)).toBe(true);

      const updated = await request(app)
        .put(`/api/suppliers/me/products/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Lifecycle Item v2", wholesalePrice: 750 });
      expect(updated.status).toBe(200);
      expect(updated.body.product.name).toBe("Lifecycle Item v2");

      const removed = await request(app)
        .delete(`/api/suppliers/me/products/${id}`)
        .set("Authorization", `Bearer ${token}`);
      expect(removed.status).toBe(200);
      createdProductIds = createdProductIds.filter((x) => x !== id);
    });

    it("will not let a supplier edit another supplier's product", async () => {
      const other = await User.create({
        Fullname: `WS Other ${TAG}`,
        email: `ws-other-${stamp()}@example.com`,
        password: "password123",
        phone: uniquePhone(),
        gender: "other",
        role: "supplier",
      });
      const otherSupplier = await Supplier.create({
        user: other._id,
        businessName: `WS Other ${TAG}`,
        phone: "0788000001",
        email: other.email,
      });
      const otherToken = jwt.sign({ userId: other._id }, JWT_SECRET, { expiresIn: "1h" });

      const created = await create({ name: "Owned Item", wholesalePrice: 100, stockQuantity: 5 });
      const id = created.body.product._id;
      createdProductIds.push(id);

      const res = await request(app)
        .put(`/api/suppliers/me/products/${id}`)
        .set("Authorization", `Bearer ${otherToken}`)
        .send({ name: "Hijacked" });
      expect(res.status).toBe(404);

      await WholesaleProduct.deleteMany({ _id: id });
      createdProductIds = createdProductIds.filter((x) => x !== id);
      await Supplier.deleteMany({ _id: otherSupplier._id });
      await User.deleteMany({ _id: other._id });
    });
  });

  describe("GET /api/suppliers/me/profile", () => {
    it("returns the signed-in supplier's own profile", async () => {
      const res = await request(app)
        .get("/api/suppliers/me/profile")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.supplier.businessName).toBe(`WS Supplier ${TAG}`);
      expect(String(res.body.supplier._id)).toBe(String(supplier._id));
    });

    it("is not shadowed by the /:idOrSlug public route", async () => {
      // "/me/profile" is two segments, so it must not be captured by the
      // single-segment public /:idOrSlug lookup that is registered first.
      const res = await request(app)
        .get("/api/suppliers/me/profile")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.supplier).toBeDefined();
    });
  });
});
