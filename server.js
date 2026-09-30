const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const helmet = require("helmet");
const morgan = require("morgan");
const cors = require("cors");
const socketService = require("./src/services/socket.service");

// Swagger setup
const swaggerUi = require("swagger-ui-express");
const YAML = require("yamljs");
const swaggerDocument = YAML.load("./swagger.yaml");

// Load all models into mongoose entry
const routes = require("./src/routes/auth.routes");
const User = require("./src/models/User");
const Category = require("./src/models/Category");
const Product = require("./src/models/Product");
const { initBackgroundWorkers } = require("./src/workers/slaWorker");

dotenv.config();

// Ensure directConnection or explicit replicaSet options are provided
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/your_database_name?replicaSet=rs0&directConnection=true";

mongoose.connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB Replica Set successfully"))
  .catch((err) => console.error("Error connecting to MongoDB:", err));

const app = express();

app.use(helmet());
app.use(cors({
  origin: "*",
  credentials: true,
}));
app.use(express.json());
app.use(morgan("dev"));

  
app.use("/api/auth", require("./src/routes/auth.routes"));
app.use("/api/search", require("./src/routes/search.routes"));
app.use("/api/products", require("./src/routes/product.routes"));
app.use("/api/categories", require("./src/routes/category.routes"));
app.use("/api/admin/suppliers", require("./src/routes/admin.supplier.routes"));
app.use("/api/suppliers", require("./src/routes/supplier.routes"));
app.use("/api/cart", require("./src/routes/cart.routes"));
app.use("/api/orders", require("./src/routes/order.routes"));
app.use("/api/stores", require("./src/routes/store.routes"));
app.use("/api/payouts", require("./src/routes/payout.routes"));
app.use("/api/staff", require("./src/routes/staff.routes"));
app.use("/api/payments", require("./src/routes/payment.routes"));
app.use("/api/admin", require("./src/routes/admin.financial.routes"));
app.use("/api/admin", require("./src/routes/admin.commission.routes"));
app.use("/api/wholesale", require("./src/routes/wholesale.routes"));
app.use("/api/disputes", require("./src/routes/dispute.routes"));
app.use("/api/abuse-reports", require("./src/routes/abuseReport.routes"));
app.use("/api/conversations", require("./src/routes/conversation.routes"));
app.use("/api/support", require("./src/routes/support.routes"));
app.use("/api/languages", require("./src/routes/language.routes"));
app.use("/api/admin", require("./src/routes/adminTranslation.routes"));
app.use("/api/vendors", require("./src/routes/vendor.routes"));
app.use("/api/admin/vendors", require("./src/routes/admin.vendor.routes"));
app.use("/api/affiliates", require("./src/routes/affiliate.routes"));
app.use("/api/webhooks", require("./src/routes/webhook.routes"));
app.use("/api/vendor", require("./src/routes/vendor.service.routes"));
app.use("/api/buyer", require("./src/routes/buyer.service.routes"));
app.use("/api/admin", require("./src/routes/admin.monetization.routes"));
app.use("/api/admin/payouts", require("./src/routes/admin.payout.routes"));
app.use("/api/developer/payouts", require("./src/routes/developer.payout.routes"));
app.use("/api/reviews", require("./src/routes/review.routes"));
app.use("/api/users", require("./src/routes/user.routes"));
app.use("/api/promotions", require("./src/routes/promotion.routes"));
app.use("/api/shipping", require("./src/routes/shipping.routes"));
app.use("/api/notifications", require("./src/routes/notification.routes"));
app.use("/api/reports", require("./src/routes/report.routes"));

// Real-time Server-Sent Events (SSE) stream for browsers
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders?.();

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ status: "connected", time: new Date() })}\n\n`);

  socketService.addSseClient(res);

  // Keep-alive heartbeat every 25 seconds
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      socketService.removeSseClient(res);
    }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    socketService.removeSseClient(res);
  });
});

// Swagger documentation route
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.get("/", (req, res) => {
  res.json({
    message: "Multi-Vendor E-Commerce API is working!",
  });
});

// Error handling middleware

// 2. 404 Handler (Triggers when NO route above matches)
app.use((req, res, next) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
});

// 3. Global Error Handling Middleware (MUST have 4 arguments: err, req, res, next)
// Express identifies this as an error handler strictly because it has 4 parameters.
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  res.status(statusCode).json({
    success: false,
    message,
    // Show stack trace only in development environment
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// Initialize background cron tasks once DB connection is established
mongoose.connection.once("open", () => {
  console.log("Connected to MongoDB.");
  initBackgroundWorkers();
});

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || "0.0.0.0";

const httpServer = http.createServer(app);
socketService.init(httpServer);

httpServer.listen(PORT, HOST, () => {
  console.log(`🚀 Server listening on ${HOST}:${PORT}`);
  console.log(`🏠 Local access: http://localhost:${PORT}`);
});

// Exported so integration tests can drive the app with supertest instead of
// booting a second listener. Tests set process.env.PORT first to avoid
// clashing with a locally running dev server.
module.exports = { app, httpServer };